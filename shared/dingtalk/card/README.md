# Card Layer

This folder contains shared DingTalk card helpers used by the agent gateway.

## Structure

```text
card/
  runtime/       # callback/task helpers still shared by platform code
  general_card.py
```

## Rules

- Keep this layer protocol-only.
- Do not put business execution or fixed process routing here.
- Single-run business cards live with the separated workflow project, not in this agent repository.
