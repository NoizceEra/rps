import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { IDL, PROGRAM_ID, type Rps } from "./idl";

export { IDL, PROGRAM_ID };

// ─── Types ───────────────────────────────────────────────────────────────────

export const CHOICES = ["Rock", "Paper", "Scissors"] as const;
export type Choice = 0 | 1 | 2;

export type GameStatus =
  | "waitingForPlayer"
  | "waitingForCommitments"
  | "waitingForReveals"
  | "finished";

export interface GameAccount {
  publicKey: PublicKey;
  gameId: BN;
  player1: PublicKey;
  player2: PublicKey | null;
  player1Commitment: number[] | null;
  player2Commitment: number[] | null;
  player1Choice: number | null;
  player2Choice: number | null;
  wager: BN;
  status: GameStatus;
  winner: PublicKey | null;
  lastAction: BN;
}

// localStorage key for a pending commitment
const COMMIT_KEY = (pda: PublicKey) => `rps_commit_${pda.toBase58()}`;

export interface SavedCommit {
  choice: Choice;
  salt: number[];
}

export function saveCommit(pda: PublicKey, commit: SavedCommit) {
  localStorage.setItem(COMMIT_KEY(pda), JSON.stringify(commit));
}

export function loadCommit(pda: PublicKey): SavedCommit | null {
  const raw = localStorage.getItem(COMMIT_KEY(pda));
  return raw ? (JSON.parse(raw) as SavedCommit) : null;
}

export function clearCommit(pda: PublicKey) {
  localStorage.removeItem(COMMIT_KEY(pda));
}

// ─── Crypto helpers ──────────────────────────────────────────────────────────

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function computeCommitment(choice: Choice, salt: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(33);
  preimage[0] = choice;
  preimage.set(salt, 1);
  return keccak_256(preimage);
}

// ─── PDA ─────────────────────────────────────────────────────────────────────

export function getGamePda(player1: PublicKey, gameId: BN): PublicKey {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(gameId.toString()));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), player1.toBuffer(), idBuf],
    new PublicKey(PROGRAM_ID)
  );
  return pda;
}

// ─── On-chain queries ─────────────────────────────────────────────────────────

function normaliseStatus(raw: Record<string, unknown>): GameStatus {
  if ("waitingForPlayer"      in raw) return "waitingForPlayer";
  if ("waitingForCommitments" in raw) return "waitingForCommitments";
  if ("waitingForReveals"     in raw) return "waitingForReveals";
  return "finished";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapGame(pubkey: PublicKey, acc: any): GameAccount {
  return {
    publicKey:        pubkey,
    gameId:           acc.gameId    as BN,
    player1:          acc.player1   as PublicKey,
    player2:          (acc.player2  as PublicKey | null),
    player1Commitment: acc.player1Commitment as number[] | null,
    player2Commitment: acc.player2Commitment as number[] | null,
    player1Choice:    acc.player1Choice as number | null,
    player2Choice:    acc.player2Choice as number | null,
    wager:            acc.wager     as BN,
    status:           normaliseStatus(acc.status as Record<string, unknown>),
    winner:           (acc.winner   as PublicKey | null),
    lastAction:       acc.lastAction as BN,
  };
}

export async function fetchAllGames(program: Program<Rps>): Promise<GameAccount[]> {
  const accounts = await program.account.game.all();
  return accounts.map((a) => mapGame(a.publicKey, a.account));
}

export async function fetchGame(
  program: Program<Rps>,
  pda: PublicKey
): Promise<GameAccount> {
  const acc = await program.account.game.fetch(pda);
  return mapGame(pda, acc);
}

// ─── Instructions ────────────────────────────────────────────────────────────

export async function txCreateGame(
  program: Program<Rps>,
  player1: PublicKey,
  gameId: BN,
  wagerLamports: BN
) {
  const game = getGamePda(player1, gameId);
  return program.methods
    .createGame(gameId, wagerLamports)
    .accounts({ game, player1, systemProgram: SystemProgram.programId })
    .rpc();
}

export async function txJoinGame(
  program: Program<Rps>,
  player2: PublicKey,
  gamePda: PublicKey
) {
  return program.methods
    .joinGame()
    .accounts({ game: gamePda, player2, systemProgram: SystemProgram.programId })
    .rpc();
}

export async function txCommitChoice(
  program: Program<Rps>,
  player: PublicKey,
  gamePda: PublicKey,
  choice: Choice,
  salt: Uint8Array
) {
  const commitment = Array.from(computeCommitment(choice, salt));
  saveCommit(gamePda, { choice, salt: Array.from(salt) });
  return program.methods
    .commitChoice(commitment)
    .accounts({ game: gamePda, player })
    .rpc();
}

export async function txRevealChoice(
  program: Program<Rps>,
  player: PublicKey,
  gamePda: PublicKey,
  choice: Choice,
  salt: Uint8Array
) {
  return program.methods
    .revealChoice(choice, Array.from(salt))
    .accounts({ game: gamePda, player })
    .rpc();
}

export async function txSettle(
  program: Program<Rps>,
  gamePda: PublicKey,
  player1: PublicKey,
  player2: PublicKey
) {
  return program.methods
    .settle()
    .accounts({ game: gamePda, player1, player2 })
    .rpc();
}

export async function txCancelGame(
  program: Program<Rps>,
  player1: PublicKey,
  gamePda: PublicKey
) {
  return program.methods
    .cancelGame()
    .accounts({ game: gamePda, player1 })
    .rpc();
}

export async function txClaimTimeout(
  program: Program<Rps>,
  gamePda: PublicKey,
  player1: PublicKey,
  player2: PublicKey,
  claimer: PublicKey
) {
  return program.methods
    .claimTimeout()
    .accounts({ game: gamePda, player1, player2, claimer })
    .rpc();
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export function shortenPubkey(pk: PublicKey | string, chars = 4): string {
  const s = pk.toString();
  return `${s.slice(0, chars)}…${s.slice(-chars)}`;
}

export function lamportsToSol(lamports: BN | number): string {
  const n = typeof lamports === "number" ? lamports : lamports.toNumber();
  return (n / 1e9).toFixed(4).replace(/\.?0+$/, "");
}

export function getStatusLabel(status: GameStatus): string {
  switch (status) {
    case "waitingForPlayer":      return "Open — Waiting for opponent";
    case "waitingForCommitments": return "In Progress — Commit phase";
    case "waitingForReveals":     return "In Progress — Reveal phase";
    case "finished":              return "Finished";
  }
}

export function getStatusColor(status: GameStatus): string {
  switch (status) {
    case "waitingForPlayer":      return "#22c55e";
    case "waitingForCommitments": return "#f59e0b";
    case "waitingForReveals":     return "#3b82f6";
    case "finished":              return "#6b7280";
  }
}

export function makeGameId(conn: Connection): BN {
  // Use current slot + random jitter as a simple unique-enough ID
  return new BN(Date.now());
}

export function buildProgram(
  connection: Connection,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any
): Program<Rps> {
  const { AnchorProvider, Program } = require("@coral-xyz/anchor");
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(IDL as unknown as Rps, provider);
}
