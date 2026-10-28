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

## Notes

<!-- Free text the model reads: tone, context, who is who. -->
<!-- Replies to the data team are in PT-BR. Keep replies short, no emoji. -->

## Learned

<!-- Maintained by the inbox from what you do: "- @author: lowered (3)" after items cleared
     without a reply, "raised" after quick replies. Edit or delete lines as you like. -->
