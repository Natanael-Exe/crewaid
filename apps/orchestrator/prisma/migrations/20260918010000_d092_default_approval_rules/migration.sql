-- D-092 — the approval defaults a bot already in the database is holding.
--
-- DATA ONLY. No table, column or index changes: `prisma migrate diff` sees
-- nothing here, which is correct — the schema did not move.
--
-- Why it has to exist. `DEFAULT_AUTO_REVIEW_RULES` is written into a row at
-- CREATION (D-064), so rewriting the constant reaches bots that do not exist
-- yet and nobody else. The bot an operator has been using for a month keeps
-- asking permission to run `ls` forever, and the fix that shipped is
-- invisible to exactly the person who reported the problem.
--
-- WHAT IS REWRITTEN, and nothing else: a list drawn ENTIRELY from the rules
-- the product seeded at one time or another — that is what `<@` tests, and
-- the right-hand side below is the union of every historical default (D-064,
-- then M5-BE-20's `board_read`, then CC-34's `memory_search`), so a bot
-- created against any of those three versions is recognised. A list holding
-- one rule an operator wrote themselves is not contained by that set, so it
-- is left exactly as it is: their policy is theirs.
--
-- An EMPTY list is left alone too, and deliberately. Under D-092 an empty
-- list no longer means "ask about everything" — the tool's own reach decides
-- when no rule matches — but an operator who emptied the list chose
-- something, and a migration is the wrong place to reinterpret a choice.
-- `{ toolPattern: '*', decision: 'ask' }` is how that intent is written now.

UPDATE "Bot"
SET "autoReviewRules" = '[{"toolPattern":"shell","argMatch":"rm -rf","decision":"ask"},{"toolPattern":"shell","argMatch":"rm -fr","decision":"ask"},{"toolPattern":"shell","argMatch":"sudo ","decision":"ask"},{"toolPattern":"shell","argMatch":"mkfs","decision":"ask"},{"toolPattern":"shell","argMatch":"dd if=","decision":"ask"},{"toolPattern":"shell","argMatch":"| sh","decision":"ask"},{"toolPattern":"shell","argMatch":"| bash","decision":"ask"},{"toolPattern":"shell","argMatch":"shutdown","decision":"ask"},{"toolPattern":"shell","argMatch":"reboot","decision":"ask"},{"toolPattern":"shell","decision":"allow"},{"toolPattern":"use_identity","decision":"ask"}]'::jsonb
WHERE "autoReviewRules" <@ '[{"toolPattern":"shell","decision":"ask"},{"toolPattern":"browser_navigate","decision":"allow"},{"toolPattern":"browser_read","decision":"allow"},{"toolPattern":"screenshot","decision":"allow"},{"toolPattern":"fs_read","decision":"allow"},{"toolPattern":"board_read","decision":"allow"},{"toolPattern":"memory_read","decision":"allow"},{"toolPattern":"memory_search","decision":"allow"}]'::jsonb
  AND jsonb_array_length("autoReviewRules") > 0;
