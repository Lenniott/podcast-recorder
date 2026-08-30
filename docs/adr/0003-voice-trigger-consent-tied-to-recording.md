# Voice Trigger listening has no separate consent toggle — it follows Record

Detecting a Voice Trigger requires continuously running speech recognition
on a participant's mic while they're in the room, which sends what they say
off-device (to Google via the Web Speech API, ADR-0001, and on to
OpenRouter whenever a trigger fires). That's a real privacy question, and
the obvious default would be a separate opt-in toggle per participant.

We deliberately didn't add one: this is a podcast recording tool, and
pressing Record already means "everything I say from now on is being
captured for the show." Voice Trigger listening starts and stops exactly
when that participant's own local recording does — no new button, no
separate consent step. A participant who never presses Record is never
transcribed and never sends anything to the Research Assistant; a
participant who does is treated as having already agreed to the same
capture, extended to this one more use. Quick Actions are unaffected by
this — they send only text that's already on screen, not live audio, so
they work regardless of recording state.
