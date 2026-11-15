// The Claude Code bundling switch, in a module of its own with no side effects, so staging can read it without
// loading the builder configuration.

/**
 * Whether the Agent SDK's native Claude Code binary ships inside the app. Off until Anthropic confirms in writing that
 * it may be redistributed: staging then leaves the `@anthropic-ai/claude-agent-sdk-*` platform packages out, and
 * Claude runs the Owner's own Claude Code from PATH. Codex and Gemini CLI are always bundled.
 */
export const BUNDLE_CLAUDE = false;
