// Manually authored IDL for the RPS program (Anchor 0.32.x format).
// After running `anchor build`, you can replace this with:
//   export { IDL } from "../../target/types/rps";
//   export type { Rps } from "../../target/types/rps";

export const PROGRAM_ID = "HomVmAdQF4SYXyajJMGzFutCGPb85fR1kQjnq1GdZXGJ";

export const IDL = {
  address: PROGRAM_ID,
  metadata: {
    name: "rps",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Rock Paper Scissors on Solana",
  },
  instructions: [
    {
      name: "createGame",
      discriminator: [124, 69, 75, 66, 184, 220, 72, 206],
      accounts: [
        {
          name: "game",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [103, 97, 109, 101] },
              { kind: "account", path: "player1" },
              { kind: "arg", path: "game_id" },
            ],
          },
        },
        { name: "player1", writable: true, signer: true },
        { name: "systemProgram", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "gameId", type: "u64" },
        { name: "wager", type: "u64" },
      ],
    },
    {
      name: "joinGame",
      discriminator: [107, 112, 18, 38, 56, 173, 60, 128],
      accounts: [
        { name: "game", writable: true },
        { name: "player2", writable: true, signer: true },
        { name: "systemProgram", address: "11111111111111111111111111111111" },
      ],
      args: [],
    },
    {
      name: "commitChoice",
      discriminator: [73, 157, 49, 7, 250, 212, 125, 182],
      accounts: [
        { name: "game", writable: true },
        { name: "player", signer: true },
      ],
      args: [{ name: "commitment", type: { array: ["u8", 32] } }],
    },
    {
      name: "revealChoice",
      discriminator: [235, 189, 39, 0, 144, 153, 52, 9],
      accounts: [
        { name: "game", writable: true },
        { name: "player", signer: true },
      ],
      args: [
        { name: "choice", type: "u8" },
        { name: "salt", type: { array: ["u8", 32] } },
      ],
    },
    {
      name: "settle",
      discriminator: [175, 42, 185, 87, 144, 131, 102, 212],
      accounts: [
        { name: "game", writable: true },
        { name: "player1", writable: true },
        { name: "player2", writable: true },
      ],
      args: [],
    },
    {
      name: "cancelGame",
      discriminator: [121, 194, 154, 118, 103, 235, 149, 52],
      accounts: [
        { name: "game", writable: true },
        { name: "player1", writable: true, signer: true },
      ],
      args: [],
    },
    {
      name: "claimTimeout",
      discriminator: [130, 234, 45, 53, 120, 90, 86, 178],
      accounts: [
        { name: "game", writable: true },
        { name: "player1", writable: true },
        { name: "player2", writable: true },
        { name: "claimer", signer: true },
      ],
      args: [],
    },
  ],
  accounts: [
    {
      name: "Game",
      discriminator: [27, 90, 166, 125, 74, 100, 121, 18],
    },
  ],
  types: [
    {
      name: "Game",
      type: {
        kind: "struct",
        fields: [
          { name: "player1", type: "publicKey" },
          { name: "player2", type: { option: "publicKey" } },
          { name: "player1Commitment", type: { option: { array: ["u8", 32] } } },
          { name: "player2Commitment", type: { option: { array: ["u8", 32] } } },
          { name: "player1Choice", type: { option: "u8" } },
          { name: "player2Choice", type: { option: "u8" } },
          { name: "wager", type: "u64" },
          { name: "status", type: { defined: { name: "GameStatus" } } },
          { name: "winner", type: { option: "publicKey" } },
          { name: "bump", type: "u8" },
          { name: "gameId", type: "u64" },
          { name: "lastAction", type: "i64" },
        ],
      },
    },
    {
      name: "GameStatus",
      type: {
        kind: "enum",
        variants: [
          { name: "WaitingForPlayer" },
          { name: "WaitingForCommitments" },
          { name: "WaitingForReveals" },
          { name: "Finished" },
        ],
      },
    },
  ],
  events: [
    {
      name: "GameCreated",
      discriminator: [0, 0, 0, 0, 0, 0, 0, 0], // populated by anchor build
    },
    {
      name: "PlayerJoined",
      discriminator: [0, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      name: "GameSettled",
      discriminator: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  ],
  errors: [
    { code: 6000, name: "InvalidGameStatus", msg: "Game is not in the expected state for this action" },
    { code: 6001, name: "CannotPlaySelf",    msg: "You cannot play against yourself" },
    { code: 6002, name: "AlreadyCommitted",  msg: "You have already committed your choice" },
    { code: 6003, name: "AlreadyRevealed",   msg: "You have already revealed your choice" },
    { code: 6004, name: "NotAPlayer",        msg: "You are not a player in this game" },
    { code: 6005, name: "InvalidChoice",     msg: "Choice must be 0 (Rock), 1 (Paper), or 2 (Scissors)" },
    { code: 6006, name: "CommitmentMismatch",msg: "Revealed choice does not match the stored commitment" },
    { code: 6007, name: "NotYetRevealed",    msg: "Both players must reveal before the game can be settled" },
    { code: 6008, name: "TimeoutNotReached", msg: "The timeout window has not elapsed yet" },
    { code: 6009, name: "InvalidPlayer",     msg: "Invalid player account provided" },
  ],
} as const;

export type Rps = typeof IDL;
