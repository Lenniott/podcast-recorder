# Use the browser's Web Speech API, not Google Cloud Speech-to-Text

The Research Assistant needs to hear both participants to detect Voice
Triggers and build the Transcript Tab. We chose the browser's built-in
`SpeechRecognition` API (Chrome/Edge stream mic audio to Google's speech
service under the hood, no credential or server involvement needed) instead
of calling the real Google Cloud Speech-to-Text API directly.

The Cloud API would need a service-account credential and, since it can't
be called with a secret exposed client-side, a server-side audio relay —
which would mean microphone audio leaving the browser and touching this
app's server. That directly conflicts with this repo's one hard rule
(`AGENTS.md`): audio never touches the server. The Web Speech API keeps
that invariant intact, at the cost of Chromium-only support (already true
of recording itself, which needs `showSaveFilePicker`) and no control over
the underlying recognition model.
