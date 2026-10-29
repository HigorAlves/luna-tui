# Slack triage rules

The inbox reads this file before every poll. Edit it freely; one entry per line, `-` bullets.
Lines starting with `<!--` are comments.

## VIPs

<!-- People whose messages are at least P1: @handle or user id, one per line. -->
<!-- - @cto -->

## Muted channels

<!-- Messages here are never stored and never leave the machine: #name or channel id. -->
<!-- - #random -->

## Always P0 keywords

<!-- A message containing one of these (case-insensitive) is P0. -->
- incident
- outage

## Quiet hours

<!-- HH:MM-HH:MM local time; only P0 raises a notice in this window. Leave empty for none. -->
<!-- 22:00-08:00 -->

## SLA

<!-- How long you give yourself to reply, by priority: Nm, Nh, N (seconds) or off. An item
     past its target turns red on the board. Missing lines fall back to these values. -->
- P0: 10m
- P1: 30m
- P2: 1h
- P3: 1h

## Notes

<!-- Free text the model reads: tone, context, who is who. -->
<!-- Replies to the data team are in PT-BR. Keep replies short, no emoji. -->

## Learned

<!-- What the inbox learned from you lives beside this file, in slack-triage.learned.md, so
     your edits here and its writes never collide. Lines here still count. -->
