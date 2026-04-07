use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::system_program;

declare_id!("HomVmAdQF4SYXyajJMGzFutCGPb85fR1kQjnq1GdZXGJ");

/// Seconds a player has to commit/reveal before being timed out.
pub const TIMEOUT_SECONDS: i64 = 300;

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod rps {
    use super::*;

    /// Player 1 creates a game and optionally deposits a SOL wager.
    ///
    /// PDA seeds: [b"game", player1_pubkey, game_id_as_le_bytes]
    pub fn create_game(ctx: Context<CreateGame>, game_id: u64, wager: u64) -> Result<()> {
        let game = &mut ctx.accounts.game;
        game.player1 = ctx.accounts.player1.key();
        game.player2 = None;
        game.player1_commitment = None;
        game.player2_commitment = None;
        game.player1_choice = None;
        game.player2_choice = None;
        game.wager = wager;
        game.status = GameStatus::WaitingForPlayer;
        game.winner = None;
        game.bump = ctx.bumps.game;
        game.game_id = game_id;
        game.last_action = Clock::get()?.unix_timestamp;

        let player1_key = game.player1;

        if wager > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.player1.to_account_info(),
                        to: ctx.accounts.game.to_account_info(),
                    },
                ),
                wager,
            )?;
        }

        emit!(GameCreated {
            game_id,
            player1: player1_key,
            wager,
        });
        Ok(())
    }

    /// Player 2 joins an open game and deposits the matching wager.
    pub fn join_game(ctx: Context<JoinGame>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::WaitingForPlayer,
            RpsError::InvalidGameStatus
        );
        require!(
            ctx.accounts.player2.key() != game.player1,
            RpsError::CannotPlaySelf
        );

        let wager = game.wager;
        let game_id = game.game_id;
        let player2_key = ctx.accounts.player2.key();
        game.player2 = Some(player2_key);
        game.status = GameStatus::WaitingForCommitments;
        game.last_action = Clock::get()?.unix_timestamp;

        if wager > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.player2.to_account_info(),
                        to: ctx.accounts.game.to_account_info(),
                    },
                ),
                wager,
            )?;
        }

        emit!(PlayerJoined {
            game_id,
            player2: player2_key,
        });
        Ok(())
    }

    /// A player commits their sealed choice: commitment = keccak256(choice_byte || salt_32_bytes)
    ///
    /// Choices: 0 = Rock, 1 = Paper, 2 = Scissors
    /// Save your choice + salt locally — you'll need them for `reveal_choice`.
    pub fn commit_choice(ctx: Context<CommitChoice>, commitment: [u8; 32]) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::WaitingForCommitments,
            RpsError::InvalidGameStatus
        );

        let player = ctx.accounts.player.key();
        if player == game.player1 {
            require!(
                game.player1_commitment.is_none(),
                RpsError::AlreadyCommitted
            );
            game.player1_commitment = Some(commitment);
        } else if Some(player) == game.player2 {
            require!(
                game.player2_commitment.is_none(),
                RpsError::AlreadyCommitted
            );
            game.player2_commitment = Some(commitment);
        } else {
            return err!(RpsError::NotAPlayer);
        }

        // Both committed — move to reveal phase
        if game.player1_commitment.is_some() && game.player2_commitment.is_some() {
            game.status = GameStatus::WaitingForReveals;
        }

        game.last_action = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// A player reveals their choice + salt. Verified on-chain against the stored commitment.
    pub fn reveal_choice(ctx: Context<RevealChoice>, choice: u8, salt: [u8; 32]) -> Result<()> {
        require!(choice <= 2, RpsError::InvalidChoice);

        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::WaitingForReveals,
            RpsError::InvalidGameStatus
        );

        // Reconstruct and verify the commitment
        let mut preimage = [0u8; 33];
        preimage[0] = choice;
        preimage[1..].copy_from_slice(&salt);
        let computed = keccak::hash(&preimage).to_bytes();

        let player = ctx.accounts.player.key();
        if player == game.player1 {
            require!(game.player1_choice.is_none(), RpsError::AlreadyRevealed);
            require!(
                game.player1_commitment == Some(computed),
                RpsError::CommitmentMismatch
            );
            game.player1_choice = Some(choice);
        } else if Some(player) == game.player2 {
            require!(game.player2_choice.is_none(), RpsError::AlreadyRevealed);
            require!(
                game.player2_commitment == Some(computed),
                RpsError::CommitmentMismatch
            );
            game.player2_choice = Some(choice);
        } else {
            return err!(RpsError::NotAPlayer);
        }

        game.last_action = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Settle the game once both players have revealed. Callable by anyone.
    ///
    /// Payout (rent always returns to player1 via `close = player1`):
    ///   player1 wins → player1 gets 2×wager + rent
    ///   player2 wins → player2 gets 2×wager,  player1 gets rent
    ///   draw         → player2 gets wager,     player1 gets wager + rent
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        require!(
            ctx.accounts.game.status == GameStatus::WaitingForReveals,
            RpsError::InvalidGameStatus
        );
        let c1 = ctx
            .accounts
            .game
            .player1_choice
            .ok_or(error!(RpsError::NotYetRevealed))?;
        let c2 = ctx
            .accounts
            .game
            .player2_choice
            .ok_or(error!(RpsError::NotYetRevealed))?;

        let game_id = ctx.accounts.game.game_id;
        let wager = ctx.accounts.game.wager;
        let result = determine_winner(c1, c2);

        // Transfer player2's share BEFORE `close = player1` fires at exit
        if wager > 0 {
            let p2_payout: u64 = match result {
                -1 => 2 * wager, // player2 wins
                0 => wager,      // draw — each gets their stake back
                _ => 0,          // player1 wins
            };
            if p2_payout > 0 {
                **ctx
                    .accounts
                    .game
                    .to_account_info()
                    .try_borrow_mut_lamports()? -= p2_payout;
                **ctx
                    .accounts
                    .player2
                    .to_account_info()
                    .try_borrow_mut_lamports()? += p2_payout;
            }
        }

        let winner = match result {
            1 => Some(ctx.accounts.game.player1),
            -1 => ctx.accounts.game.player2,
            _ => None,
        };

        emit!(GameSettled {
            game_id,
            player1_choice: c1,
            player2_choice: c2,
            winner,
        });

        // Anchor's `close = player1` sends remaining lamports to player1 and zeros the account
        Ok(())
    }

    /// Player 1 cancels a game before anyone has joined. Full refund via `close`.
    pub fn cancel_game(_ctx: Context<CancelGame>) -> Result<()> {
        Ok(())
    }

    /// Claim a timeout win when the opponent missed the commit or reveal window.
    ///
    /// WaitingForCommitments:
    ///   one committed, other didn't  → committer wins all
    ///   neither committed            → both refunded
    /// WaitingForReveals:
    ///   one revealed, other didn't   → revealer wins all
    ///   neither revealed             → both refunded
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now - ctx.accounts.game.last_action >= TIMEOUT_SECONDS,
            RpsError::TimeoutNotReached
        );

        let claimer = ctx.accounts.claimer.key();
        let player1_key = ctx.accounts.game.player1;
        let player2_key = ctx
            .accounts
            .game
            .player2
            .ok_or(error!(RpsError::NotAPlayer))?;
        let wager = ctx.accounts.game.wager;

        require!(
            claimer == player1_key || claimer == player2_key,
            RpsError::NotAPlayer
        );

        // How many lamports does player2 get? (player1 gets the rest via `close`)
        let p2_payout: u64 = match ctx.accounts.game.status {
            GameStatus::WaitingForCommitments => {
                match (
                    ctx.accounts.game.player1_commitment.is_some(),
                    ctx.accounts.game.player2_commitment.is_some(),
                ) {
                    (true, false) => {
                        require!(claimer == player1_key, RpsError::NotAPlayer);
                        0
                    }
                    (false, true) => {
                        require!(claimer == player2_key, RpsError::NotAPlayer);
                        2 * wager
                    }
                    _ => wager, // neither/both — refund both
                }
            }
            GameStatus::WaitingForReveals => {
                match (
                    ctx.accounts.game.player1_choice.is_some(),
                    ctx.accounts.game.player2_choice.is_some(),
                ) {
                    (true, false) => {
                        require!(claimer == player1_key, RpsError::NotAPlayer);
                        0
                    }
                    (false, true) => {
                        require!(claimer == player2_key, RpsError::NotAPlayer);
                        2 * wager
                    }
                    _ => wager, // neither/both — refund both
                }
            }
            _ => return err!(RpsError::InvalidGameStatus),
        };

        if p2_payout > 0 {
            **ctx
                .accounts
                .game
                .to_account_info()
                .try_borrow_mut_lamports()? -= p2_payout;
            **ctx
                .accounts
                .player2
                .to_account_info()
                .try_borrow_mut_lamports()? += p2_payout;
        }

        Ok(())
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Returns  1 if player1 wins, -1 if player2 wins, 0 for a draw.
/// Rock = 0, Paper = 1, Scissors = 2
fn determine_winner(c1: u8, c2: u8) -> i8 {
    if c1 == c2 {
        return 0;
    }
    if (c1 == 0 && c2 == 2) || (c1 == 1 && c2 == 0) || (c1 == 2 && c2 == 1) {
        1
    } else {
        -1
    }
}

// ─── Account Contexts ────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(
        init,
        payer = player1,
        space = 8 + Game::SIZE,
        seeds = [b"game", player1.key().as_ref(), &game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub player1: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGame<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub player2: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitChoice<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevealChoice<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        close = player1,
        constraint = game.player1 == player1.key()        @ RpsError::InvalidPlayer,
        constraint = game.player2 == Some(player2.key())  @ RpsError::InvalidPlayer,
    )]
    pub game: Account<'info, Game>,
    /// CHECK: Player 1 — receives remaining lamports when the account closes
    #[account(mut)]
    pub player1: UncheckedAccount<'info>,
    /// CHECK: Player 2 — receives wager payout if they win or draw
    #[account(mut)]
    pub player2: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelGame<'info> {
    #[account(
        mut,
        close = player1,
        constraint = game.player1 == player1.key()                    @ RpsError::InvalidPlayer,
        constraint = game.status  == GameStatus::WaitingForPlayer     @ RpsError::InvalidGameStatus,
    )]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub player1: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(
        mut,
        close = player1,
        constraint = game.player1 == player1.key()       @ RpsError::InvalidPlayer,
        constraint = game.player2 == Some(player2.key()) @ RpsError::InvalidPlayer,
    )]
    pub game: Account<'info, Game>,
    /// CHECK: Player 1 — receives remaining lamports when the account closes
    #[account(mut)]
    pub player1: UncheckedAccount<'info>,
    /// CHECK: Player 2 — receives payout if they win or are refunded
    #[account(mut)]
    pub player2: UncheckedAccount<'info>,
    pub claimer: Signer<'info>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[account]
pub struct Game {
    pub player1: Pubkey,                      // 32
    pub player2: Option<Pubkey>,              // 33
    pub player1_commitment: Option<[u8; 32]>, // 33
    pub player2_commitment: Option<[u8; 32]>, // 33
    pub player1_choice: Option<u8>,           // 2
    pub player2_choice: Option<u8>,           // 2
    pub wager: u64,                           // 8
    pub status: GameStatus,                   // 1
    pub winner: Option<Pubkey>,               // 33
    pub bump: u8,                             // 1
    pub game_id: u64,                         // 8
    pub last_action: i64,                     // 8
} // = 194

impl Game {
    pub const SIZE: usize = 32 + 33 + 33 + 33 + 2 + 2 + 8 + 1 + 33 + 1 + 8 + 8; // 194
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    WaitingForPlayer,      // 0
    WaitingForCommitments, // 1
    WaitingForReveals,     // 2
    Finished,              // 3
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct GameCreated {
    pub game_id: u64,
    pub player1: Pubkey,
    pub wager: u64,
}

#[event]
pub struct PlayerJoined {
    pub game_id: u64,
    pub player2: Pubkey,
}

#[event]
pub struct GameSettled {
    pub game_id: u64,
    pub player1_choice: u8,
    pub player2_choice: u8,
    pub winner: Option<Pubkey>,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum RpsError {
    #[msg("Game is not in the expected state for this action")]
    InvalidGameStatus,
    #[msg("You cannot play against yourself")]
    CannotPlaySelf,
    #[msg("You have already committed your choice")]
    AlreadyCommitted,
    #[msg("You have already revealed your choice")]
    AlreadyRevealed,
    #[msg("You are not a player in this game")]
    NotAPlayer,
    #[msg("Choice must be 0 (Rock), 1 (Paper), or 2 (Scissors)")]
    InvalidChoice,
    #[msg("Revealed choice does not match the stored commitment")]
    CommitmentMismatch,
    #[msg("Both players must reveal before the game can be settled")]
    NotYetRevealed,
    #[msg("The timeout window has not elapsed yet")]
    TimeoutNotReached,
    #[msg("Invalid player account provided")]
    InvalidPlayer,
}
