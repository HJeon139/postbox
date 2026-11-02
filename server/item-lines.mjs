// How a conversation item reads to an agent, in its history, catch-up, topic-thread opener and read tools (#109,
// #153), moved out of runtime.mjs. Runtime’s describeItem and topicRootLine call these.

import { READING } from '../shared/limits.mjs';
import { commentAt } from '../shared/review-comments.mjs';
import { appCheckText } from './app-check-status.mjs';
import { closedText } from './blocks.mjs';
import { clipText, fenced } from './helpers.mjs';

const COMMAND_CONTEXT = 4000;
const count = (n) => n.toLocaleString('en-US');
/**
 * An item’s text cut to n characters for an agent’s history. A cut says how much was kept and gives the id
 * read_message takes, so the agent can read the rest (#109).
 */
export const clipItem = (s, n, id) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}… (${count(n)} of ${count(t.length)} characters; read_message { id: "${id}" } has the rest)` : t;
};

/**
 * What a block holds, as text an agent can read and quote (#153): a review, card or code block’s content, a choice
 * or form’s prompt and options or fields, any other block’s fallback, and the person’s answer if there is one. An
 * app is its title alone, which its agent’s line names.
 * @param {any} it  a block item
 */
function blockContent(it) {
  const b = it.block ?? {};
  const out = [];
  switch (b.type) {
    case 'review':
      if (b.format === 'app') out.push(`It reviews the app ${b.appId}.`);
      else out.push(b.format === 'code' ? `${b.filename ? `${b.filename}:\n` : ''}${fenced(b.content ?? '', b.language)}` : String(b.content ?? ''));
      for (const th of b.threads ?? []) out.push(`Comments on ${commentAt(th)} (${th.status}):\n${lines(th.comments.map((c) => `${c.author}: ${c.text}`))}`);
      break;
    case 'card':
      if (b.body) out.push(b.body);
      if (b.facts?.length) out.push(lines(b.facts.map((f) => `${f.label}: ${f.value}`)));
      if (b.actions?.length) out.push(`Buttons: ${b.actions.map((x) => x.label).join(' · ')}`);
      break;
    case 'code':
      out.push(`${b.filename ? `${b.filename}:\n` : ''}${fenced(b.code ?? '', b.language)}`);
      break;
    case 'choice':
      if (b.prompt) out.push(b.prompt);
      out.push(
        `Options${b.multiple ? ' (any of them)' : ''}: ${b.options.map((o) => o.label).join(' · ')}${b.other ? `, or their own (${b.other.label})` : ''}`,
      );
      break;
    case 'form':
      if (b.prompt) out.push(b.prompt);
      out.push(
        `Fields:\n${lines(b.fields.map((f) => `${f.label} (${f.kind}${f.required ? ', required' : ''})${f.options ? `: ${f.options.map((o) => o.label).join(' · ')}` : ''}`))}`,
      );
      break;
    case 'confirm':
      out.push(b.statement);
      break;
    case 'app':
      return '';
    default:
      out.push(String(b.fallback ?? ''));
  }
  const a = it.answered ? it.answer : null;
  if (it.closed) out.push(closedText(it));
  else if (a) out.push(answerText(b, a));
  if (b.outcome) out.push(`Outcome: ${b.outcome}`);
  return out.filter(Boolean).join('\n\n');
}

/** A bulleted list, one line per entry. */
const lines = (list) => list.map((x) => `- ${x}`).join('\n');

/** The person’s answer to a block, as blockContent gives it. */
function answerText(b, a) {
  const v = a.values ?? {};
  if (b.type === 'review') {
    const comments = Array.isArray(v.comments) ? v.comments : [];
    return `The person’s review: ${String(a.voice ?? '').replace(/^Submitted review: /, '')}${comments.length ? `\n${lines(comments.map((c) => `${commentAt(c)}: ${c.text}`))}` : ''}`;
  } else if (b.type === 'form') {
    const shown = (f) => {
      const x = v[f.id];
      if (f.kind === 'toggle') return x ? 'on' : 'off';
      if (f.kind === 'select') return f.options?.find((o) => o.id === x)?.label ?? x;
      return String(x);
    };
    return `The person answered:\n${lines(b.fields.filter((f) => v[f.id] !== undefined && v[f.id] !== '').map((f) => `${f.label}: ${shown(f)}`)) || '- (nothing filled in)'}`;
  } else if (b.type === 'choice') {
    const picked = (v.selected ?? []).map((id) => b.options.find((o) => o.id === id)?.label ?? id);
    return `The person answered: ${[...picked, ...(v.other ? [`“${v.other}”`] : [])].join(' · ')}`;
  } else return `The person answered: ${a.voice ?? a.action}`;
}

/**
 * A message’s attachments, for the agent reading it (#671). A local agent gets the path it can open, as the turn the
 * message was sent to gives it (guide.mjs’s formatBody); one on a remote host gets their names, since only that turn
 * copies them there (remote/attachments.mjs). With no reader, the names alone.
 * @param {any} rt @param {any[] | undefined} list @param {any} reader  the session reading it, or null
 */
function attachedText(rt, list, reader) {
  if (!list?.length) return '';
  const remote = Boolean(reader && rt.remote?.hostOf(rt.personaFor(reader)));
  const names = list.map((a) => {
    const name = a.name ?? a.path;
    const where = reader && !remote ? rt.attachmentPath(reader.threadId, a) : null;
    return where ? `${name} at ${where}` : name;
  });
  const note = remote ? ' Your host can’t open attachments from earlier messages yet: ask the person to paste what you need.' : '';
  return ` [attached: ${names.join(', ')}]${note}`;
}

/**
 * The message a topic thread started from, for an agent’s first turn there (#81, #228); null for anything else.
 */
export function topicRootLine(rt, se, t) {
  if (t?.kind !== 'topic') return null;
  const root = rt.store.item(t.parentId, t.rootItemId);
  if (!root) return null;
  // The thread is about this message, so it gets more room than an item in the catch-up.
  const text = (s) => clipItem(s, 4000, root.id);
  const from = 'This thread started from';
  switch (root.kind) {
    case 'user':
      return `${from} your message: ${text(root.text)}${attachedText(rt, root.attachments, se)}`;
    case 'agent':
      return `${from} @${root.handle}’s message: ${text(root.text)}`;
    case 'block': {
      // The title names it; what it holds is the text an agent can quote (a draft, or a table’s rows) (#153).
      const b = root.block ?? {};
      const what = b.type === 'app' ? 'app' : b.type ? `${b.type} block` : 'block';
      const body = (root.valid && blockContent(root)) || String(b.fallback ?? root.fallback ?? '');
      return `${from} @${root.handle}’s ${what}${b.title ? ` “${clipText(String(b.title), 200)}”` : ''}: ${text(body)}`;
    }
    default: {
      const line = describeItem(rt, root, se);
      return line ? `${from} this message: ${line}` : null;
    }
  }
}

/**
 * One conversation item as a line an agent can read, from the point of view of `se`; null to leave it out. Its
 * text is cut at n characters, saying so (#109). `reader`, the session its attachments are given to, is `se` unless the
 * read tools pass their caller, with no `se` (#671).
 * @param {any} rt @param {any} i @param {any} [se] @param {number} [n] @param {any} [reader]
 */
export function describeItem(rt, i, se = null, n = READING.item, reader = se) {
  const text = (s) => clipItem(s, n, i.id);
  switch (i.kind) {
    case 'user':
      return `You: ${text(i.text)}${attachedText(rt, i.attachments, reader)}`;
    case 'agent':
      // A reply that wrote its text and then failed still reaches the others, marked: it had been dropped, so a
      // report written before the turn failed reached no one (#485).
      // One retried since says so too: the retry’s reply follows it.
      if (!i.text) return null;
      return i.status === 'failed' || i.status === 'retried'
        ? `@${i.handle} (this reply ${i.status === 'retried' ? 'failed and was retried' : 'failed'}: ${clipText(i.error || 'unknown', 200)}): ${text(i.text)}`
        : `@${i.handle}: ${text(i.text)}`;
    case 'block': {
      if (!i.valid) return null;
      // What it holds comes with it, so another agent can review it (#153).
      const body =
        n === Number.POSITIVE_INFINITY && i.block.type === 'app' && rt.s.apps[i.block.id]?.itemId === i.id
          ? appCheckText(rt.s.apps[i.block.id])
          : blockContent(i);
      const what = i.block.type === 'app' ? 'an app' : `a ${i.block.type} block`;
      const title = i.block.title ?? (i.block.type === 'app' ? i.block.fallback : null);
      return text(
        `@${i.handle} showed ${what}${title ? ` “${clipText(String(title), 200)}”` : ''}${body ? `${body.includes('\n') ? ':\n' : ': '}${body}` : ''}`,
      );
    }
    case 'voice': {
      // The agent hears about its own blocks as events already.
      const block = i.blockItemId && rt.store.item(se?.threadId, i.blockItemId);
      if (block && block.sessionId === se?.id) return null;
      // An app’s summary is its own wording, never the person’s (#51).
      return `You: ${text(i.text)}${i.quote ? `\nThe app’s own summary, not the person’s words: “${text(i.quote)}”` : ''}`;
    }
    case 'shared':
      return `${i.summary ? 'Summary' : 'Shared'} from the thread “${i.fromTitle}”${i.agent ? `, by @${i.handle} in a turn the person started` : i.handle ? `, by @${i.handle}` : ', by the person'}: ${i.question ? `You asked: “${text(i.question)}” ` : ''}${text(i.text)}`;
    case 'system':
      if (i.variant === 'wake') return `${i.from === 'you' ? 'You' : `@${i.from}`} woke @${i.to}`;
      if (i.variant === 'joined') return `@${i.to} joined`;
      if (i.variant === 'left') return `@${i.to} left`;
      if (i.variant === 'dataset') return `@${i.handle} loaded the dataset “${i.dataset}” (${i.records} records); search it by naming it in books`;
      return null;
    case 'sidelink':
      return `@${i.from} and @${i.to} talked in a side thread (${i.count ?? 0} messages${i.threadSummary ? `; in short, as a model summarized it: “${i.threadSummary}”` : ''}; read_conversation with thread: "${i.sideThreadId}" reads it)`;
    case 'command':
      // A `!command` the person ran (#67), with its output, as Claude Code’s bash mode passes it on.
      return commandLine(i);
    case 'proposal':
      return `@${i.handle} proposed a new teammate, @${i.proposal?.handle}`;
    default:
      return null;
  }
}

/** A `!command` the person ran (#67), with its output, as describeItem gives it. */
function commandLine(i) {
  const how =
    i.status === 'running'
      ? 'it’s still running'
      : i.status === 'stopped'
        ? 'they stopped it'
        : i.error
          ? `it couldn’t start: ${i.error}`
          : `it exited with ${i.exitCode ?? i.signal}`;
  const out = String(i.text ?? '');
  const tail = out.length > COMMAND_CONTEXT ? `…${out.slice(-COMMAND_CONTEXT)}` : out;
  return `You ran \`${clipText(String(i.command), 500)}\` in ${i.cwd} (${how}).${tail.trim() ? ` Output${i.cut || tail !== out ? ', the end of it' : ''}:\n\`\`\`\n${tail}\n\`\`\`` : ' No output.'}`;
}
