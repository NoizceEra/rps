import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Rps } from "../target/types/rps";
import { keccak_256 } from "@noble/hashes/sha3";
import { expect } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROCK     = 0;
const PAPER    = 1;
const SCISSORS = 2;

function randomSalt(): Buffer {
  return Buffer.from(Keypair.generate().secretKey.slice(0, 32));
}

function makeCommitment(choice: number, salt: Buffer): Buffer {
  const preimage = Buffer.alloc(33);
  preimage[0] = choice;
  salt.copy(preimage, 1);
  return Buffer.from(keccak_256(preimage));
}

function gamePda(
  player1: PublicKey,
  gameId: BN,
  programId: PublicKey
): PublicKey {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(gameId.toString()));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), player1.toBuffer(), idBuf],
    programId
  );
  return pda;
}

async function airdrop(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
  sol = 2
) {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("rps", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program  = anchor.workspace.Rps as Program<Rps>;
  const conn     = provider.connection;

  // player1 == provider wallet; create a fresh player2 each suite
  let player2: Keypair;
  let gameIdCounter = 0;

  function nextGameId(): BN {
    return new BN(++gameIdCounter);
  }

  beforeEach(async () => {
    player2 = Keypair.generate();
    await airdrop(conn, player2.publicKey);
  });

  // ── create & cancel ──────────────────────────────────────────────────────

  it("creates a free game", async () => {
    const gameId = nextGameId();
    const gamePubkey = gamePda(provider.wallet.publicKey, gameId, program.programId);

    await program.methods
      .createGame(gameId, new BN(0))
      .accounts({ game: gamePubkey, player1: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    const game = await program.account.game.fetch(gamePubkey);
    expect(game.player1.toBase58()).to.eq(provider.wallet.publicKey.toBase58());
    expect(game.wager.toNumber()).to.eq(0);
    expect(game.status).to.deep.eq({ waitingForPlayer: {} });
  });

  it("creates a wager game and player2 joins", async () => {
    const wager  = new BN(0.1 * LAMPORTS_PER_SOL);
    const gameId = nextGameId();
    const gamePubkey = gamePda(provider.wallet.publicKey, gameId, program.programId);

    await program.methods
      .createGame(gameId, wager)
      .accounts({ game: gamePubkey, player1: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .joinGame()
      .accounts({ game: gamePubkey, player2: player2.publicKey, systemProgram: SystemProgram.programId })
      .signers([player2])
      .rpc();

    const game = await program.account.game.fetch(gamePubkey);
    expect(game.player2).to.not.be.null;
    expect(game.player2!.toBase58()).to.eq(player2.publicKey.toBase58());
    expect(game.status).to.deep.eq({ waitingForCommitments: {} });

    // PDA should hold 2×wager
    const lamports = await conn.getBalance(gamePubkey);
    expect(lamports).to.be.gte(wager.toNumber() * 2);
  });

  it("player1 can cancel an unjoined game", async () => {
    const wager  = new BN(0.05 * LAMPORTS_PER_SOL);
    const gameId = nextGameId();
    const gamePubkey = gamePda(provider.wallet.publicKey, gameId, program.programId);

    await program.methods
      .createGame(gameId, wager)
      .accounts({ game: gamePubkey, player1: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    const before = await conn.getBalance(provider.wallet.publicKey);

    await program.methods
      .cancelGame()
      .accounts({ game: gamePubkey, player1: provider.wallet.publicKey })
      .rpc();

    const after = await conn.getBalance(provider.wallet.publicKey);
    // Got refund (minus tx fees)
    expect(after).to.be.gt(before - 10_000);

    // Account should be closed
    const closed = await conn.getAccountInfo(gamePubkey);
    expect(closed).to.be.null;
  });

  // ── commit / reveal / settle ─────────────────────────────────────────────

  async function playGame(
    choice1: number,
    choice2: number,
    wagerSol = 0.1
  ): Promise<{
    gamePubkey: PublicKey;
    p1Before: number;
    p2Before: number;
    p1After: number;
    p2After: number;
  }> {
    const wager  = new BN(wagerSol * LAMPORTS_PER_SOL);
    const gameId = nextGameId();
    const gamePubkey = gamePda(provider.wallet.publicKey, gameId, program.programId);

    const salt1 = randomSalt();
    const salt2 = randomSalt();
    const comm1 = Array.from(makeCommitment(choice1, salt1));
    const comm2 = Array.from(makeCommitment(choice2, salt2));

    // create + join
    await program.methods
      .createGame(gameId, wager)
      .accounts({ game: gamePubkey, player1: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .joinGame()
      .accounts({ game: gamePubkey, player2: player2.publicKey, systemProgram: SystemProgram.programId })
      .signers([player2])
      .rpc();

    // commit
    await program.methods
      .commitChoice(comm1)
      .accounts({ game: gamePubkey, player: provider.wallet.publicKey })
      .rpc();

    await program.methods
      .commitChoice(comm2)
      .accounts({ game: gamePubkey, player: player2.publicKey })
      .signers([player2])
      .rpc();

    // reveal
    await program.methods
      .revealChoice(choice1, Array.from(salt1))
      .accounts({ game: gamePubkey, player: provider.wallet.publicKey })
      .rpc();

    await program.methods
      .revealChoice(choice2, Array.from(salt2))
      .accounts({ game: gamePubkey, player: player2.publicKey })
      .signers([player2])
      .rpc();

    const p1Before = await conn.getBalance(provider.wallet.publicKey);
    const p2Before = await conn.getBalance(player2.publicKey);

    // settle (anyone can call)
    await program.methods
      .settle()
      .accounts({
        game:    gamePubkey,
        player1: provider.wallet.publicKey,
        player2: player2.publicKey,
      })
      .rpc();

    return {
      gamePubkey,
      p1Before,
      p2Before,
      p1After: await conn.getBalance(provider.wallet.publicKey),
      p2After: await conn.getBalance(player2.publicKey),
    };
  }

  it("player1 wins (Rock beats Scissors)", async () => {
    const { p1Before, p1After, p2Before, p2After, gamePubkey } =
      await playGame(ROCK, SCISSORS, 0.1);

    // Account closed
    expect(await conn.getAccountInfo(gamePubkey)).to.be.null;
    // player1 gained roughly 2×wager (minus fees)
    expect(p1After).to.be.gt(p1Before);
    // player2 lost their wager
    expect(p2After).to.be.lt(p2Before);
  });

  it("player2 wins (Scissors beats Paper)", async () => {
    const { p1After, p1Before, p2After, p2Before, gamePubkey } =
      await playGame(PAPER, SCISSORS, 0.1);

    expect(await conn.getAccountInfo(gamePubkey)).to.be.null;
    expect(p2After).to.be.gt(p2Before);
    expect(p1After).to.be.lt(p1Before);
  });

  it("draw returns wagers (Rock vs Rock)", async () => {
    const wagerLamports = 0.1 * LAMPORTS_PER_SOL;
    const { p1After, p1Before, p2After, p2Before, gamePubkey } =
      await playGame(ROCK, ROCK, 0.1);

    expect(await conn.getAccountInfo(gamePubkey)).to.be.null;
    // Both should be close to where they started (minus small tx fees)
    const tolerance = 20_000; // lamports
    expect(Math.abs(p1After - p1Before)).to.be.lt(tolerance);
    expect(Math.abs(p2After - p2Before)).to.be.lt(tolerance);
  });

  it("rejects invalid commitment on reveal", async () => {
    const wager  = new BN(0);
    const gameId = nextGameId();
    const gamePubkey = gamePda(provider.wallet.publicKey, gameId, program.programId);

    await program.methods.createGame(gameId, wager)
      .accounts({ game: gamePubkey, player1: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods.joinGame()
      .accounts({ game: gamePubkey, player2: player2.publicKey, systemProgram: SystemProgram.programId })
      .signers([player2])
      .rpc();

    const salt = randomSalt();
    await program.methods.commitChoice(Array.from(makeCommitment(ROCK, salt)))
      .accounts({ game: gamePubkey, player: provider.wallet.publicKey })
      .rpc();

    await program.methods.commitChoice(Array.from(makeCommitment(PAPER, salt)))
      .accounts({ game: gamePubkey, player: player2.publicKey })
      .signers([player2])
      .rpc();

    // Try to reveal with wrong choice
    try {
      await program.methods
        .revealChoice(SCISSORS, Array.from(salt)) // committed ROCK, revealing SCISSORS
        .accounts({ game: gamePubkey, player: provider.wallet.publicKey })
        .rpc();
      expect.fail("Should have thrown CommitmentMismatch");
    } catch (err: any) {
      expect(err.message).to.include("CommitmentMismatch");
    }
  });

  it("rejects non-player committing", async () => {
    const gameId = nextGameId();
    const gamePubkey = gamePda(provider.wallet.publicKey, gameId, program.programId);
    const stranger = Keypair.generate();
    await airdrop(conn, stranger.publicKey);

    await program.methods.createGame(gameId, new BN(0))
      .accounts({ game: gamePubkey, player1: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods.joinGame()
      .accounts({ game: gamePubkey, player2: player2.publicKey, systemProgram: SystemProgram.programId })
      .signers([player2])
      .rpc();

    const salt = randomSalt();
    try {
      await program.methods.commitChoice(Array.from(makeCommitment(ROCK, salt)))
        .accounts({ game: gamePubkey, player: stranger.publicKey })
        .signers([stranger])
        .rpc();
      expect.fail("Should have thrown NotAPlayer");
    } catch (err: any) {
      expect(err.message).to.include("NotAPlayer");
    }
  });
});
