// Anchor migration — runs once on `anchor migrate`.
// The RPS program is stateless at the workspace level (game accounts are
// created per-game by players), so no global initialisation is needed.
const anchor = require("@coral-xyz/anchor");

module.exports = async function (provider: typeof anchor.AnchorProvider) {
  anchor.setProvider(provider);
  console.log("RPS program deployed. Program ID:", provider.connection.rpcEndpoint);
};
