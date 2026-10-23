# Long research: a dataset scan and a use case to file

- persona: A machine learning engineer scoping an internal support assistant: retrieval over the help center, or a customized model. Knows ML well, is short on time, writes short messages, and asks one thing at a time over a long afternoon. Never says how an answer should look.
- agents: researcher
- models: persona
- steps: 20
- project: Support assistant
- conversation: Retrieval or customization

Work with @researcher for at least ten turns, one question at a time, as over an afternoon. Write as you would to a colleague, and don’t ask for any particular format. Turn by turn, notice whether you could answer, decide, sort or sign off with a click or had to type it out, and whether that held late in the session as well as early ([#63](https://github.com/HJeon139/postbox/issues/63)).

## Phase 1: The question

Ask whether retrieval over the help center is a good fit, or whether the team should invest in customizing a model. Follow up three or four times, one at a time: how fresh the help center is, what each costs, and how you’d tell which works better. When it weighs the options, decide with whatever it offers, then ask what to do first.

## Phase 2: The dataset scan

Ask it to find public datasets you could evaluate on: support conversations or FAQ-style question answering, at least ten of them, with size, license and what each is good for. Then ask which three to start with, closest to real support tickets first, and narrow the list once more.

## Phase 3: The use case document

Ask it to write up the use case as a one-page document for the team’s shared docs: the problem, the approach you picked, the datasets, and how you’ll know it works. Say it must follow the existing documents’ numbering without taking a number that’s in use. Tell it one claim is too strong, then sign off when it reads right, before it goes anywhere the team can see.
