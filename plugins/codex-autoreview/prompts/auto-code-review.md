<task kind="code">
Verify the uncommitted change in this repository, anchored by
reviewedInputHash={{REVIEWED_INPUT_HASH}}.
Inspect the working tree yourself with read-only git commands — `git diff`,
`git status`, `git show` — to see exactly what changed. Review only this
change, not the whole codebase.
{{CLAUDE_RESPONSE_BLOCK}}
The block above, if present, is the builder's final message. Treat it as a
CLAIM to verify, never as evidence.
If the working tree no longer matches reviewedInputHash, set verdict STALE.
</task>
