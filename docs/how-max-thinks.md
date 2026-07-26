# How Max thinks

Engineer-to-engineer explanation of the current system's concepts and
decision logic — not a feature list, not a file inventory. Written to give
you a mental model you can reason from before looking at code.

---

## 1. Architecture

Two runtimes, one deployment. A Python process is the brain: conversation,
memory, moderation, the web dashboard, and every decision about *whether*
and *what* to say. A Node process is the ears and mouth for voice, and
exists for exactly one reason — Discord's voice protocol is end-to-end
encrypted, and no Python library can decrypt received audio, only Node's
voice stack can. So capture and playback live in Node; everything about
what the words *mean* lives in Python.

The two talk over a loopback HTTP API secured by a shared key. Node POSTs
raw decoded audio to Python and gets synthesized speech back in the same
response when it's a direct reply. For speech that originates on a timer
rather than in response to one utterance (see §7), Python instead pushes
audio to Node out-of-band through a small control API Node also exposes
(join/leave/speak/status).

Inside the Python process, one event loop runs four things concurrently:
the Discord gateway connection, the dashboard's web server, the Node
process as a supervised subprocess (restarted with backoff if it dies,
its stdout piped into the same log stream), and a watchdog that checks
gateway health every 30 seconds and force-restarts the whole process if
the gateway's been dead for 5 minutes.

**Text lifecycle.** A message arrives on the gateway. Several independent
listeners see every message: automod (banned words / invites / mention
spam — pure regex/count matching, no model involved), the conversational
handler, a pressure classifier, and a de-escalation observer. If the
message mentions Max or lands in a channel configured for always-on
replies, the conversational handler assembles a system prompt (see §8),
appends the recent channel history, and calls the model. The model can
call tools in a loop (see §5) before producing final text. The reply is
chunked to fit Discord's message limit and sent; both sides of the
exchange are appended to the memory turn buffer (see §4).

**Voice lifecycle.** Someone speaks. Discord delivers that speaker's audio
as its own encrypted stream; Node decrypts and decodes it, buffers until
about a second of silence ends the utterance, and drops it immediately if
it's too short or too quiet to be real speech (see §6). Surviving audio is
POSTed to Python, transcribed, and filtered for transcription
hallucinations. The resulting text fans out to the same set of listeners
text gets — transcript buffer, banned-word check, memory, pressure
classifier, de-escalation observer — plus a wake-word check. A wake match
starts a short cancellable window before Max actually generates and speaks
a reply (§6 has the detail).

## 2. The pressure system

It is not a single "how excited is Max" score. It's a small set of
independent pressure reservoirs — call them buckets — one each for:
helping with something (assist), correcting a wrong claim (correct),
following up on something promised earlier (follow_up), asking for
clarification (clarify), a safety/moderation concern (moderate), and idle
social participation (social).

**What creates pressure.** Every message and voice utterance is classified
by a model into zero or more typed signals — "this looks like an
unresolved blocker, confidence 0.8, about topic X, here's one line of
evidence." Each signal type routes to exactly one bucket with a default
weight (an unresolved blocker feeds assist; an incorrect technical claim
feeds correct; a safety concern feeds moderate; general topic relevance
feeds social, and so on). When a signal lands, its bucket's pressure
increases by `gain × weight × confidence`, capped at a ceiling so no
bucket can grow without bound. Signals are deduplicated by an idempotency
key — the same underlying thing observed twice doesn't double-charge.

**What reduces it.** Two independent forces. First, every 30 seconds a
tick applies exponential decay to every bucket — pressure that isn't being
reinforced fades on its own, at different rates per bucket (moderate fades
fastest, over roughly 10 minutes; social fades slowest, over roughly
7.5 minutes; the rest sit in between). Second, discharge: when Max
actually speaks about something, that bucket loses 85% of its pressure
immediately — not all of it, so it can't be re-triggered instantly, but
most of it. There's also silent discharge with no speech involved at all:
a signal resolves — and its pressure leaves the bucket — the moment
someone else visibly solves the thing, the topic goes unmentioned long
enough to count as abandoned, the classifier's confidence in it drops too
low, or it simply outlives a maximum lifetime.

**How thresholds work.** Each bucket has a fixed number pressure must
clear before speech is even considered: moderate is lowest (safety gets
raised soonest), assist and correct sit in the middle, clarify is higher
(Max should be quite sure before "I'm confused" behavior fires), and
social is highest by a wide margin — idle chat needs much more
accumulated justification than a real blocker does. But raw bucket
pressure isn't what's compared to the threshold — it's *topic-scoped*
pressure: what fraction of a bucket's live signal strength is actually
about the specific topic in question right now. A bucket that's hot
because of an old, unrelated thread doesn't license speaking into a new
one.

**How it decides to speak.** Crossing threshold only means a candidate
exists. Before anything is said, a deterministic gate (no model call)
checks seven things, and all seven must pass: topic-scoped pressure over
threshold; the proposed content is relevant to what's actually being
discussed; it adds genuinely new information rather than restating
something; the same point hasn't already been made recently (checked
against a log of past proactive contributions); no cooldown is active —
there are four independent cooldown scopes, global, channel, speaker, and
topic, all of which start the moment Max speaks; the topic isn't already
resolved, abandoned, or expired; and Max isn't barging into an active
back-and-forth between people (defined structurally as several messages
from multiple distinct people inside a short recent window — a real
exchange, not a lull). On top of the gate there's a hard budget (at most a
couple of proactive messages per channel in any ten-minute window) and an
energy scalar that drains a fixed amount every time Max speaks and slowly
regenerates — a ceiling on chattiness that's independent of how much
pressure exists, so no amount of legitimate pressure can make him talk
constantly.

There's a cost-control step in front of all this: a nearly-free "probe"
checks whether the gate would even open given current state, and only if
that passes does the system pay for an actual drafting call. The drafting
model gets one more veto of its own — it's explicitly told to decide
honestly whether it has something to add and to decline if not — and a
decline resolves the underlying signal so it doesn't just re-fire on the
next tick, without ever producing a message.

## 3. The event loop

Purely event-driven for everything reactive. There is no "Max is always
thinking" background loop scanning conversations — every text message and
every voice utterance arrives as a discrete event and is handled inline.
The only two things that run on a timer are the pressure engine's tick
(every 30 seconds: decay, the small cross-bucket pressure flow, expiry
checks, and "is anything now over threshold") and the liveness watchdog's
health check (every 30 seconds). Memory maintenance runs on every single
turn, not a timer or a threshold — see the pipeline below.

The concrete event list: message received, voice utterance received (from
Node, over HTTP), voice channel joined/left (from Node), slash command
invoked, member joined/left (drives welcome messages), and the two 30-
second timers above.

## 4. Memory pipeline

Every text message and every transcribed voice utterance — from humans and
from Max himself — is appended as one line to a rolling in-memory buffer,
per server, capped at the 60 most recent lines. This step is a pure buffer
append; no model is involved and nothing is persisted yet.

Every single turn then triggers a live consolidation call: given current
durable memory, current working memory, current per-member profile cards,
and the raw recent turns, the model merges new stable facts, preferences,
and decisions into durable memory (each entry dated and tagged with a
confidence level), deduplicates, drops anything superseded, and separately
rewrites working memory — current topic, active speakers, open questions,
recent meaningful exchanges, paraphrased and attributed — down to just
what's still live. Both files (plus any profile updates) come back in one
response; if that response can't be parsed as valid structured output,
nothing is overwritten — a bad model response leaves the previous memory
intact rather than corrupting it. There's no turn-count threshold and no
wall-clock debounce: this used to be batched (every 12th turn for working
memory, every 80th for durable) to bound spend on a paid model; now that
these background calls route through a free model pool, batching only
costs latency for no savings, so it runs every time instead. To avoid
piling up overlapping calls when turns arrive faster than the model
responds — a burst of rapid voice chatter, say — a per-guild in-flight
flag coalesces them: turns that land mid-run just mark that fresher
content arrived, and the in-flight run loops once more for it immediately
after finishing, rather than queuing a redundant call per turn.

Retrieval has no ranking step at all: every reply-generating call anywhere
in the system — a mention reply, a direct question, a wake-word response,
a proactive contribution — gets the *entire* durable file and the entire
working file pasted into its system prompt, always, labeled as such.
There's no embedding search, no relevance filtering, no per-topic lookup.
Durable memory is capped at roughly 5,000 characters and working memory at
roughly 2,500; once durable memory fills up, the only pressure valve is
the consolidation step's own summarization/dedup judgment. Memory is
scoped per server, not per channel or per user, and doesn't distinguish
whether a fact originated in text or voice once it's written down.

## 5. Tools

Two access tiers, gated by who's talking.

Anyone who can address Max — a mention, or a channel configured for
always-on replies — gets: a web search tool; a GitHub repository lookup
that also fires automatically (outside the tool-call mechanism entirely)
whenever a message contains a github.com link, attaching that repo's
stats and README as context before the model even responds; and four
read-only tools over Max's own source code — list the tree, regex-search
it, read a file or line range, list dependencies. Those four are
sandboxed to the repository root, refuse to read anything that looks like
a secret, database, or generated file, and redact anything matching a
known credential shape from their output regardless.

Only the configured owner additionally gets roughly two dozen tools that
take direct action on the server: the full moderation set (kick, ban,
unban, timeout, remove timeout, warn, list/clear warnings, purge messages,
set slowmode, lock a channel), channel and role management (create,
delete, set topic; give, take, create, delete role), sending a message as
Max, and read-only lookups (server info, list channels/roles, member info,
search members, recent mod-log entries) that the model is expected to use
to resolve a name before acting rather than guessing. These are invoked
directly by the model from plain conversation — "kick that guy" — not
through slash commands; the owner's system prompt explicitly tells the
model it has hands and must act, not redirect to a command.

Every tool call happens inside a bounded loop within a single reply: the
model asks for a tool, code executes it and hands back text, the model can
ask for another, up to a fixed number of round trips, after which one
final round is forced tool-free so a reply always comes back even if the
model wanted to keep going.

## 6. The wake-word pipeline

**Speech to text.** Segmentation happens on the Node side using Discord's
own per-speaker end-of-speech signal (roughly a second of silence), not a
heuristic in Python. The resulting raw audio is wrapped in a WAV container
and posted to any OpenAI-compatible transcription endpoint (Whisper,
whether served by OpenAI or Groq).

**Speaker identification is structural, not inferred.** Discord's voice
protocol hands each speaker their own physically separate audio stream
tagged with their Discord user ID — "who's talking" is a lookup against
that ID, never a voice-similarity guess. That means zero risk of
attributing speech to the wrong person, but also means two people sharing
one microphone are indistinguishable to the system.

**Filtering happens before transcription is even attempted.** Two gates
run purely on the raw audio, on the Node side, before anything is sent
anywhere: a minimum utterance duration and a minimum loudness floor
computed directly from the waveform. A slammed door or a chair creak never
reaches the transcription API. After transcription, two more layers catch
what those gates miss: a fixed blocklist of known transcription
hallucinations (silence and noise reliably produce phrases like "thank
you" or "bye-bye" from Whisper-family models), and a short-phrase repeat
suppressor that drops an identical short utterance from the same person if
it repeats within a short window — background noise-gate chatter that
isn't an exact blocklist match but is obviously not real speech.

**Wake detection** is a punctuation-stripped, case-folded substring match
against a configurable list of phrases, checked on every transcribed line.
A match starts a short, deliberately cancellable window — a configured
cancel phrase heard before the reply is generated (or, using the same
mechanism, anywhere before it lands) aborts the whole thing silently, no
message, no generation cost paid.

**Context sent to the model after a wake match:** the full assembled
system prompt (persona, self-description, tools, memory — see §8) plus a
voice-specific addendum establishing that Max is live in this channel and
naming who just addressed him, plus — if the configured text-to-speech
backend supports delivery tags — a paragraph teaching the model that
backend's specific tag vocabulary, plus the most recent lines of that
channel's rolling transcript across all speakers (a fixed recency window,
not filtered by relevance). One model call, with the same tools available
as any other reply. The reply text is posted to the channel and,
separately, synthesized and pushed to the voice channel for playback; any
delivery tags are stripped from what's shown in text but preserved in what
goes to speech.

## 7. Autonomous behavior

Two independent systems can make Max speak without being addressed, and
they're worth keeping conceptually separate even though the second is
nominated by the first.

**Proactive contribution** is everything in §2 — the pressure gate. Its
safeguards against constant talking are the seven gate conditions plus the
budget and energy ceiling described there; nothing new to add here beyond
noting that "can he interrupt" and "will the gate actually let him" are
two different questions, and the gate is the one that's authoritative.

**De-escalation** is a second, more restrained state machine that only
engages when a safety-concern signal fires. Getting flagged doesn't make
Max say anything by itself — it only nominates that channel for closer
reads on every subsequent message. Each read reduces the recent
conversation to a structured judgment: is tension rising, steady, or
falling; how many people are involved; are insults targeted and repeating;
is there a credible threat; was a request to stop ignored; is there
sustained disruptive cross-talk; and, critically, does this actually read
as banter, teasing, roleplay, or passionate debate. That last field is a
hard override — if a read comes back as banter, the system stays silent
regardless of anything else it also flagged, specifically so a loud joking
argument or a passionate but good-faith debate never gets treated as a
real conflict. Profanity and volume alone never count as serious on their
own.

If something genuinely is judged serious, a per-channel state machine —
persisted, so a restart mid-conflict resumes at the right step — climbs a
three-rung ladder: a single neutral check-in, then a suggestion to pause
or take a personal dispute to DMs, then a notification to moderators.
Every rung requires a *fresh* confirming read, not the same anger counted
twice, and a minimum time gap since the last step, so it structurally
cannot spam-escalate off one bad classification. A credible threat skips
straight to notifying moderators regardless of what rung it's on. Once
moderators are notified, Max goes silent on that channel — the system
never takes an action itself; no timeout, no kick, nothing punitive exists
in this code path at all, by design. The conflict resets to idle
automatically once tension reads as falling, or after a stretch with
nothing serious detected. A separate, much lower-stakes preference track
exists for servers that want sustained harsh language (without targeting)
gently called out — but that track is structurally incapable of climbing
past the first rung, so it can never become a moderator alert on its own.

## 8. How personality and prompts are organized

Not a single static prompt, and not separate personality files — four
layers, assembled fresh on every single call:

1. **Persona.** One block of text, stored per server, editable without
   touching code. This is the only layer meant for a non-technical
   operator to change.
2. **Self-description.** Computed, not stored — the server's name and
   member count, and the actual live list of registered commands read
   directly from the bot's command registry, so this can never drift out
   of sync with what commands really exist. Paired with a fixed paragraph
   describing the passive systems running in the background (automod,
   welcome messages, the dashboard, voice monitoring, the pressure
   system).
3. **Abilities and role.** A fixed paragraph on what tools exist and how
   to use them, plus a role-conditional block that's the one place *who's
   talking* changes prompt structure rather than just conversation
   content: a regular member gets told Max can't act on their behalf and
   should point them at commands; the owner gets told the opposite — act
   directly, don't suggest, ask one clarifying question first only when a
   request is both ambiguous and destructive.
4. **Memory.** Both memory files, appended verbatim if non-empty.

Two more additions get appended only when the reply is going to be spoken
in voice: a short framing establishing that Max is live in that channel
and who addressed him, and — only if the configured voice backend supports
delivery tags — a paragraph teaching whichever tag vocabulary that
specific backend uses, chosen dynamically based on what's configured
rather than hardcoded to one style.

Nothing here is retrieved from a file or picked from a few-shot library —
it's string assembly, computed fresh per request, guaranteed to reflect
current configuration and state.

## 9. Models

Two configured model slots, both changeable per server without a
redeploy.

**The conversational model** handles every reply a human actually
sees or hears — mention replies, direct questions, wake-word responses,
and the final drafted text of a proactive contribution. It's the only slot
whose output a person directly experiences, which is deliberate: it's
currently pointed at a rotating pool of free models specifically to
evaluate coherence at zero marginal cost, having previously been a paid
model.

**The utility model** handles everything invisible: turning messages into
pressure signals, both memory-maintenance steps, and de-escalation's
context assessments. It defaults to the same free pool. The reasoning:
these calls dramatically outnumber conversational replies in practice
(background classification and memory upkeep made up the large majority
of total call volume before this split existed), their output is consumed
by deterministic code rather than read by a person, and occasional
incoherence from a free model is something code can detect and retry
rather than something a person notices as a bad vibe.

Two things had to be built to make the free pool usable at all, and both
matter for understanding current behavior. First, at least one model in
that pool ignores whatever it's actually asked and always answers with a
bare safety-classifier verdict — the client recognizes that exact shape
and silently retries so the pool's rotation lands on a different model,
and everything downstream is additionally built to no-op on garbage rather
than act on it if a junk response ever slips through. Second, many free
models don't support function calling at all — a tool-call rejection
triggers an automatic retry of the same request with tools stripped, so a
reply degrades to plain text instead of failing outright.

There is no dedicated coding-specialist model. The introspection tools are
just tools the conversational model calls; whichever model is in the
conversational slot is the one reasoning about Max's own source when asked
to.

## 10. Current limitations

**Memory doesn't scale by relevance.** There's no retrieval step — the
entire durable file goes into every prompt regardless of whether it's
relevant to what's being discussed right now. Once it approaches its
character cap, the only pressure valve is how well one summarization call
compresses and dedupes it, which is a single point of quality failure with
no verification step behind it.

**Voice has no streaming anywhere.** Silence detection, the wake grace
window, transcription, generation, and speech synthesis all happen
sequentially and fully before anything is heard — realistically several
seconds between finishing "hey Max" and hearing the first word back.
Nothing in the chain is streamed.

**Hallucination risk is layered and only partially mitigated, not
eliminated.** Transcription hallucinates on silence and noise (a
blocklist plus loudness/duration gates catch the common cases, not all of
them). The free-model pool sometimes returns malformed or off-task
structured output from classification or drafting calls (tolerant parsing
and junk-rejection catch structural garbage, not semantic garbage) — a
response that's well-formed but simply *wrong* about what happened in a
conversation is not currently detectable by anything in the system.

**Tool execution has a prompt-level safety net, not a code-level one.**
The owner's system prompt says to ask before an ambiguous destructive
action; nothing in code enforces a second confirmation before a
moderation tool actually executes. That's a real gap between what the
model is told to do and what the system can guarantee it does.

**Voice quality silently degrades.** The good path (an expressive,
delivery-tag-aware backend) and the fallback path (a flat, non-expressive
one that ignores delivery tags entirely) produce noticeably different
output, and the switch between them happens automatically and silently
whenever the primary backend is unset or errors — there's no signal
surfaced when a reply went out on the lesser path.

**Pressure and de-escalation reliability is coupled to the utility
model's classification consistency**, and that model is now a rotating
pool rather than one fixed model. Both systems only behave as well as the
structured judgment they're handed; a pool that sometimes returns
different-quality reasoning for structurally similar situations will
produce trigger behavior that feels inconsistent run to run in ways that
are hard to reproduce on demand. This is the most likely explanation for
tonight's sporadic-feeling wake and proactive behavior.

**Nothing is scoped below "the whole server."** Pressure state, memory,
and the de-escalation ladder are all per-guild. There's no per-channel
isolation beyond what the current-topic tracking naturally provides, no
per-user memory, and this hasn't been stress-tested against a server with
many simultaneously active channels.

**Test coverage stops at the two pure-logic modules.** The pressure engine
and the de-escalation gate both have real unit test suites and are
deterministic, I/O-free, and easy to verify in isolation. Nothing covers
the actual integration surface — Discord event handling, the Python/Node
HTTP bridge, the memory pipeline, or tool execution — so regressions there
are currently caught by production observation, not by CI.

**The Python/Node split is the single most fragile seam in the system.**
It exists only because Discord's encrypted voice protocol has no Python
receive path, not because splitting the runtime this way is good design
on its own terms. It's the direct cause of most of the operational bugs
already chased in this system's lifetime — authentication mismatches
between the two processes, startup-order races, and the supervision logic
needed to keep a subprocess alive.

## 11. Roadmap — next concrete steps, in priority order

1. **Stop using a rotating free-model pool for classification.** Pin
   pressure-signal classification and de-escalation assessment to one
   specific, verified-reliable model (or add a cheap deterministic
   pre-filter ahead of it). This is the most likely fix for the
   inconsistent trigger behavior noticed tonight, because free-pool
   rotation is a demonstrated, real source of inconsistent structured
   output — not a guess.
2. **Give memory a relevance step instead of dumping the whole file into
   every prompt.** Durable memory only grows; fix retrieval before it's
   forced into more aggressive, lossier consolidation by its own size cap.
3. **Collapse the Python/Node split into one runtime.** This removes the
   single most fragile seam by construction instead of by patching around
   it — and is exactly the direction tonight's from-scratch Node rebuild
   is already heading.
4. **Add integration tests around the two real pipelines** — message
   through classification through the gate to a spoken reply, and voice
   utterance through transcription to a wake response — not just the two
   pure-logic modules that already have coverage.
5. **Stream the voice path.** Partial transcription and streamed
   synthesis, once a single runtime (item 3) makes that something to build
   once instead of twice across a process boundary.
6. **Add a code-level confirmation gate for destructive owner tools**,
   independent of the prompt instruction that currently is the only thing
   asking the model to check first.
7. **Per-channel scoping for pressure and memory**, once real usage shows
   cross-channel bleed is an actual problem rather than a theoretical one.
8. **Pin a tested transcription/TTS pairing with an explicit quality
   floor**, replacing silent degradation to a lesser backend with a
   visible signal when that happens.

Every item above maps directly onto "what to build next" for the ground-up
rebuild already underway tonight — this list is effectively the layer
order.
