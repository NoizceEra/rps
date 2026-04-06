import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  IDL,
  PROGRAM_ID,
  CHOICES,
  type Choice,
  type GameAccount,
  type GameStatus,
  type Rps,
  type SavedCommit,
  randomSalt,
  computeCommitment,
  saveCommit,
  loadCommit,
  clearCommit,
  getGamePda,
  fetchAllGames,
  txCreateGame,
  txJoinGame,
  txCommitChoice,
  txRevealChoice,
  txSettle,
  txCancelGame,
  txClaimTimeout,
  shortenPubkey,
  lamportsToSol,
  getStatusLabel,
  getStatusColor,
} from "./rps-client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CHOICE_EMOJI: Record<number, string> = { 0: "🪨", 1: "📄", 2: "✂️" };
const CHOICE_NAME:  Record<number, string> = { 0: "Rock", 1: "Paper", 2: "Scissors" };

function useProgram() {
  const { connection } = useConnection();
  const wallet = useWallet();
  return useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    const provider = new AnchorProvider(connection, wallet as never, {
      commitment: "confirmed",
    });
    return new Program(IDL as unknown as Rps, provider);
  }, [connection, wallet]);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusPill({ status }: { status: GameStatus }) {
  return (
    <span className="status-pill" style={{ color: getStatusColor(status) }}>
      <span
        className="status-dot"
        style={{ background: getStatusColor(status) }}
      />
      {getStatusLabel(status)}
    </span>
  );
}

// ─── Create Game Modal ────────────────────────────────────────────────────────

function CreateGameModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (wagerSol: number) => Promise<void>;
}) {
  const [wager, setWager] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function handleCreate() {
    setBusy(true);
    setErr("");
    try {
      await onCreate(parseFloat(wager) || 0);
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Create New Game</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Wager (SOL) — leave blank for free game</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={wager}
              onChange={(e) => setWager(e.target.value)}
            />
          </div>
          <div className="info-banner">
            A unique game will be created on-chain. Share your wallet address
            with your opponent so they can join.
          </div>
          {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={handleCreate}>
            {busy ? <span className="spinner" /> : "Create Game"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Game Detail Modal ────────────────────────────────────────────────────────

function GameModal({
  game,
  myKey,
  onClose,
  onAction,
}: {
  game: GameAccount;
  myKey: PublicKey;
  onClose: () => void;
  onAction: () => void;
}) {
  const program = useProgram();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [selectedChoice, setSelectedChoice] = useState<Choice | null>(null);

  const isPlayer1 = game.player1.equals(myKey);
  const isPlayer2 = game.player2?.equals(myKey) ?? false;
  const isMyGame  = isPlayer1 || isPlayer2;
  const savedCommit: SavedCommit | null = loadCommit(game.publicKey);

  async function run(fn: () => Promise<string>) {
    if (!program) return;
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const sig = await fn();
      setMsg(`Tx confirmed: ${sig.slice(0, 8)}…`);
      onAction();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleJoin() {
    run(() => txJoinGame(program!, myKey, game.publicKey));
  }

  function handleCommit() {
    if (selectedChoice === null) { setErr("Pick a choice first."); return; }
    const salt = randomSalt();
    run(() => txCommitChoice(program!, myKey, game.publicKey, selectedChoice, salt));
  }

  function handleReveal() {
    if (!savedCommit) { setErr("No saved commitment found. Did you commit in this browser?"); return; }
    run(() =>
      txRevealChoice(
        program!,
        myKey,
        game.publicKey,
        savedCommit.choice,
        Uint8Array.from(savedCommit.salt)
      ).then((sig) => { clearCommit(game.publicKey); return sig; })
    );
  }

  function handleSettle() {
    run(() =>
      txSettle(program!, game.publicKey, game.player1, game.player2!)
    );
  }

  function handleCancel() {
    run(() => txCancelGame(program!, myKey, game.publicKey));
  }

  function handleClaimTimeout() {
    run(() =>
      txClaimTimeout(program!, game.publicKey, game.player1, game.player2!, myKey)
    );
  }

  // What action is available to me right now?
  const myCommitted =
    (isPlayer1 && game.player1Commitment !== null) ||
    (isPlayer2 && game.player2Commitment !== null);
  const myRevealed =
    (isPlayer1 && game.player1Choice !== null) ||
    (isPlayer2 && game.player2Choice !== null);
  const bothRevealed = game.player1Choice !== null && game.player2Choice !== null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Game #{game.gameId.toString()}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div className="game-detail">
            {/* Status */}
            <div className="detail-row">
              <span className="label">Status</span>
              <StatusPill status={game.status} />
            </div>

            {/* Wager */}
            <div className="detail-row">
              <span className="label">Wager</span>
              <span className="value" style={{ color: "#f59e0b" }}>
                {game.wager.toNumber() === 0
                  ? "Free game"
                  : `${lamportsToSol(game.wager)} SOL each`}
              </span>
            </div>

            {/* Players */}
            <div className="detail-row">
              <span className="label">Player 1</span>
              <span className="value">
                {shortenPubkey(game.player1)}
                {isPlayer1 && <span style={{ color: "#7c3aed", marginLeft: 6 }}>(you)</span>}
              </span>
            </div>
            <div className="detail-row">
              <span className="label">Player 2</span>
              <span className="value">
                {game.player2
                  ? <>
                      {shortenPubkey(game.player2)}
                      {isPlayer2 && <span style={{ color: "#7c3aed", marginLeft: 6 }}>(you)</span>}
                    </>
                  : <span style={{ color: "var(--muted)" }}>Not yet joined</span>}
              </span>
            </div>

            {/* Commitments progress */}
            {(game.status === "waitingForCommitments" || game.status === "waitingForReveals") && (
              <div className="detail-row">
                <span className="label">Commitments</span>
                <span className="value">
                  P1: {game.player1Commitment ? "✅" : "⏳"}  P2: {game.player2Commitment ? "✅" : "⏳"}
                </span>
              </div>
            )}

            {/* Reveals progress */}
            {game.status === "waitingForReveals" && (
              <div className="detail-row">
                <span className="label">Reveals</span>
                <span className="value">
                  P1: {game.player1Choice !== null ? CHOICE_EMOJI[game.player1Choice] : "⏳"}
                  {"  "}
                  P2: {game.player2Choice !== null ? CHOICE_EMOJI[game.player2Choice] : "⏳"}
                </span>
              </div>
            )}

            {/* Winner */}
            {game.winner && (
              <div className="detail-row">
                <span className="label">Winner</span>
                <span className="value" style={{ color: "#22c55e" }}>
                  {game.winner.equals(myKey) ? "🏆 You!" : shortenPubkey(game.winner)}
                </span>
              </div>
            )}
          </div>

          {/* ── Actions ── */}
          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Join */}
            {game.status === "waitingForPlayer" && !isMyGame && (
              <button className="btn btn-primary btn-full" disabled={busy} onClick={handleJoin}>
                {busy ? <span className="spinner" /> : `Join Game${game.wager.toNumber() > 0 ? ` (${lamportsToSol(game.wager)} SOL)` : ""}`}
              </button>
            )}

            {/* Cancel (player1, before anyone joins) */}
            {game.status === "waitingForPlayer" && isPlayer1 && (
              <button className="btn btn-danger btn-full" disabled={busy} onClick={handleCancel}>
                {busy ? <span className="spinner" /> : "Cancel & Refund"}
              </button>
            )}

            {/* Commit choice */}
            {game.status === "waitingForCommitments" && isMyGame && !myCommitted && (
              <>
                <div className="choice-grid">
                  {([0, 1, 2] as Choice[]).map((c) => (
                    <button
                      key={c}
                      className={`choice-btn${selectedChoice === c ? " active" : ""}`}
                      onClick={() => setSelectedChoice(c)}
                    >
                      <span className="emoji">{CHOICE_EMOJI[c]}</span>
                      {CHOICES[c]}
                    </button>
                  ))}
                </div>
                <div className="info-banner">
                  Your choice is hidden from your opponent until both have committed.
                  Save this page — you'll need to reveal later.
                </div>
                <button className="btn btn-primary btn-full" disabled={busy || selectedChoice === null} onClick={handleCommit}>
                  {busy ? <span className="spinner" /> : "Seal My Choice"}
                </button>
              </>
            )}

            {game.status === "waitingForCommitments" && isMyGame && myCommitted && (
              <div className="success-banner">
                ✅ Choice committed — waiting for opponent to commit.
              </div>
            )}

            {/* Reveal */}
            {game.status === "waitingForReveals" && isMyGame && !myRevealed && (
              <>
                {savedCommit ? (
                  <div className="info-banner">
                    Your sealed choice: <strong>{CHOICE_EMOJI[savedCommit.choice]} {CHOICE_NAME[savedCommit.choice]}</strong>
                  </div>
                ) : (
                  <div className="error-banner">
                    ⚠️ No saved commitment found in this browser. If you committed from another device,
                    you'll need to reveal manually.
                  </div>
                )}
                <button className="btn btn-primary btn-full" disabled={busy || !savedCommit} onClick={handleReveal}>
                  {busy ? <span className="spinner" /> : "Reveal My Choice"}
                </button>
              </>
            )}

            {game.status === "waitingForReveals" && isMyGame && myRevealed && !bothRevealed && (
              <div className="success-banner">
                ✅ Choice revealed — waiting for opponent to reveal.
              </div>
            )}

            {/* Settle (anyone can call once both have revealed) */}
            {game.status === "waitingForReveals" && bothRevealed && (
              <button className="btn btn-green btn-full" disabled={busy} onClick={handleSettle}>
                {busy ? <span className="spinner" /> : "🏆 Settle Game & Pay Winner"}
              </button>
            )}

            {/* Claim timeout */}
            {(game.status === "waitingForCommitments" || game.status === "waitingForReveals") && isMyGame && (
              <button
                className="btn btn-outline btn-sm"
                style={{ alignSelf: "center", marginTop: 4 }}
                disabled={busy}
                onClick={handleClaimTimeout}
              >
                ⏱ Claim Timeout (5 min)
              </button>
            )}
          </div>

          {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
          {msg && <div className="success-banner" style={{ marginTop: 12 }}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { publicKey } = useWallet();
  const program = useProgram();

  const [games, setGames]               = useState<GameAccount[]>([]);
  const [loading, setLoading]           = useState(false);
  const [showCreate, setShowCreate]     = useState(false);
  const [selectedGame, setSelectedGame] = useState<GameAccount | null>(null);

  const refresh = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const all = await fetchAllGames(program);
      setGames(all);
    } catch (e) {
      console.error("Failed to fetch games:", e);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    if (program) refresh();
  }, [program, refresh]);

  // Re-select updated game after refresh
  useEffect(() => {
    if (selectedGame) {
      const updated = games.find((g) => g.publicKey.equals(selectedGame.publicKey));
      if (updated) setSelectedGame(updated);
    }
  }, [games]); // eslint-disable-line

  async function handleCreate(wagerSol: number) {
    if (!program || !publicKey) return;
    const gameId = new BN(Date.now());
    await txCreateGame(program, publicKey, gameId, new BN(Math.round(wagerSol * LAMPORTS_PER_SOL)));
    await refresh();
  }

  // Partition games
  const myGames = games.filter(
    (g) => publicKey && (g.player1.equals(publicKey) || g.player2?.equals(publicKey))
  );
  const openGames = games.filter(
    (g) =>
      g.status === "waitingForPlayer" &&
      publicKey &&
      !g.player1.equals(publicKey)
  );

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="logo">
          RPS<span>.</span>SOL
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {publicKey && (
            <button
              className="btn btn-outline btn-sm"
              onClick={refresh}
              disabled={loading}
              title="Refresh games"
            >
              {loading ? <span className="spinner" style={{ borderTopColor: "var(--primary)" }} /> : "↻ Refresh"}
            </button>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <main className="main">
        {!publicKey ? (
          <div className="connect-prompt">
            <div style={{ fontSize: 64 }}>🪨📄✂️</div>
            <h2>Rock Paper Scissors on Solana</h2>
            <p>
              Provably fair on-chain RPS with commit-reveal and SOL wagers.
              <br />Connect your wallet to play.
            </p>
            <WalletMultiButton />
          </div>
        ) : (
          <>
            {/* My Games */}
            <section className="section">
              <div className="section-header">
                <h2>My Games {myGames.length > 0 && `(${myGames.length})`}</h2>
                <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
                  + New Game
                </button>
              </div>
              {myGames.length === 0 ? (
                <div className="empty-state">
                  No active games. Create one or join an open game below.
                </div>
              ) : (
                <div className="game-grid">
                  {myGames.map((g) => (
                    <GameCard
                      key={g.publicKey.toBase58()}
                      game={g}
                      myKey={publicKey}
                      onClick={() => setSelectedGame(g)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Open Games */}
            <section className="section">
              <div className="section-header">
                <h2>Open Games {openGames.length > 0 && `(${openGames.length})`}</h2>
              </div>
              {openGames.length === 0 ? (
                <div className="empty-state">
                  No open games to join right now. Create one and share your wallet address!
                </div>
              ) : (
                <div className="game-grid">
                  {openGames.map((g) => (
                    <GameCard
                      key={g.publicKey.toBase58()}
                      game={g}
                      myKey={publicKey}
                      onClick={() => setSelectedGame(g)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Modals */}
      {showCreate && (
        <CreateGameModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
      {selectedGame && (
        <GameModal
          game={selectedGame}
          myKey={publicKey!}
          onClose={() => setSelectedGame(null)}
          onAction={refresh}
        />
      )}
    </div>
  );
}

// ─── Game Card ────────────────────────────────────────────────────────────────

function GameCard({
  game,
  myKey,
  onClick,
}: {
  game: GameAccount;
  myKey: PublicKey;
  onClick: () => void;
}) {
  const isPlayer1 = game.player1.equals(myKey);
  const isPlayer2 = game.player2?.equals(myKey) ?? false;

  return (
    <div className="game-card" onClick={onClick}>
      {game.wager.toNumber() > 0 && (
        <div className="wager-badge">⚡ {lamportsToSol(game.wager)} SOL</div>
      )}
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
        Game #{game.gameId.toString().slice(-6)}
      </div>
      <StatusPill status={game.status} />
      <div className="player-row" style={{ marginTop: 10 }}>
        P1: {shortenPubkey(game.player1)}
        {isPlayer1 && <span style={{ color: "#7c3aed" }}> (you)</span>}
        {" · "}
        P2: {game.player2
          ? <>
              {shortenPubkey(game.player2)}
              {isPlayer2 && <span style={{ color: "#7c3aed" }}> (you)</span>}
            </>
          : <span style={{ color: "var(--muted)" }}>open</span>}
      </div>
    </div>
  );
}
