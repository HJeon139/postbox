// How Codex app-server’s approval requests become Postbox permission cards and MCP elicitation answers.

import { draftOf } from '../write-guard.mjs';
import { POSTBOX_SERVER } from './setup.mjs';

/** Map Codex app-server approval requests onto Postbox permissions and MCP elicitation responses. */
export async function codexApproval(ctx, msg) {
  const p = msg.params ?? {};
  if (msg.method === 'mcpServer/elicitation/request') {
    const meta = p._meta ?? {};
    // A tool call is marked by its kind, or only by its message (“Allow the github MCP server to run tool
    // “create_issue”?”): either way the card names the tool and shows its arguments, never a generic prompt (#150).
    const named = /run tool ["“]([^"”]+)["”]/i.exec(String(p.message ?? ''))?.[1];
    if (meta.codex_approval_kind === 'mcp_tool_call' || named) {
      const server = String(p.serverName ?? 'mcp').slice(0, 80);
      const name = String(meta.tool_name ?? meta.toolName ?? named ?? 'tool').slice(0, 80);
      // Postbox tools only update the current conversation. Like the Agent SDK, let those run directly;
      // the MCP endpoint still validates every call and the UI actions are intentionally user-scoped.
      if (server === POSTBOX_SERVER) return { action: 'accept', content: {} };
      const tool = `mcp__${server}__${name}`;
      const args = meta.tool_params ?? {};
      const detail = JSON.stringify(
        {
          ...(meta.tool_description ? { description: meta.tool_description } : {}),
          arguments: args,
        },
        null,
        2,
      );
      const answer = await ctx.askPermission({
        tool,
        summary: `use ${server} tool ${name}`,
        detail,
        toolUseId: msg.id,
        suppressAlways: true,
        // A write’s draft shows as Markdown on the card (#112). No input: Codex can’t run an edited call.
        ...(draftOf(tool, args) ? { draft: draftOf(tool, args) } : {}),
      });
      return answer?.allow ? { action: 'accept', content: {} } : { action: 'decline' };
    }
    const server = String(p.serverName ?? 'MCP server').slice(0, 80);
    const answer = await ctx.askPermission({
      tool: `mcp__${server}__elicitation`,
      summary: `respond to ${server}`,
      // It asks the person for input, not for leave to act, so Run everything doesn’t answer it (#371).
      kind: 'input',
      detail: String(p.message ?? 'The MCP server requests input.'),
      toolUseId: msg.id,
      suppressAlways: true,
    });
    return answer?.allow ? { action: 'accept', content: {} } : { action: 'decline' };
  }
  const isCommand = msg.method === 'item/commandExecution/requestApproval';
  const isFile = msg.method === 'item/fileChange/requestApproval';
  if (isCommand || isFile) {
    const summary = isFile ? 'change files' : 'run a command';
    const detail =
      [p.command ?? p.reason ?? p.networkApprovalContext?.host ?? p.grantRoot, p.cwd ? `Working directory: ${p.cwd}` : null].filter(Boolean).join('\n\n') ||
      summary;
    const answer = await ctx.askPermission({ tool: isFile ? 'Edit' : 'Bash', summary, detail, toolUseId: p.itemId, suppressAlways: true });
    return { decision: answer?.allow ? 'accept' : 'decline' };
  }
  throw new Error(`Unsupported Codex app-server request: ${msg.method ?? 'unknown'}`);
}
