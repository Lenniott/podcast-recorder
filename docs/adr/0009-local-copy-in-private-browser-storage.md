# Local Copy is written in private browser storage and saved out after the take

The room could only keep a Local Copy by writing into a folder the person picked with `showDirectoryPicker`, which locked joining to Chrome and Edge. Safari and Firefox can download a file, and they can write a growing file in the origin's private storage, but they cannot open that picker. We decided every browser writes the Local Copy there while the take is running, in place, so a crash leaves the bytes already written. When a take stops for real, that browser asks the person to save. The save downloads a WAV, does not wait for the server copy, and is the moment the file becomes something they can open. The page cannot see whether a download finished (Safari can refuse it), so saving deletes nothing: the private file is removed only when the person clicks Remove and confirms, once the saved file opens. Until then it stays listed, with its length, across a refresh and a later visit. A take that dies before it closes is repaired from the file size, marked as ended early, and saved the same way. A rejected Check Turn is listed and not asked. The folder screen before the mic goes away. The browser's leave warning still shows only while a take is being written or a server copy is still uploading; the upload warning tells them to save first if they will need to send the file, and they can still leave.

## Considered options

- **Keep the folder picker on Chrome, and use private storage only where the picker is missing.** Rejected. Two ways of losing a take, and two stories about what the Local Copy is.
- **Hold the take until Stop, then write it.** Rejected. `localStorage` is a few megabytes of strings. A 50-minute 48 kHz 16-bit mono take is on the order of 275 MB. A crash before Stop would drop the insurance the Local Copy exists to be.
- **The ordinary file writer, which publishes the file only when the take closes cleanly.** Rejected for the same reason. Each chunk has to land in the file as it arrives.
- **Start the download from the Stop click, or from the host's remote stop.** Rejected. Patching the WAV header happens after the click, and Safari drops the permission to download across that wait. A guest stopped by the host never clicked on that machine.
- **Delete an unsaved take when they leave, when the server copy finishes, or when the next take starts.** Rejected. That is how a recording disappears while the screen still looks fine.
- **Block leaving until they save.** Rejected. The upload often finishes shortly after Stop. The leave warning already covers a write still in progress and an upload still in progress.
- **Keep the pre-mic Local Copy screen so the storage request has its own click.** Rejected. The mic step's Continue click is enough of a gesture. A refusal still lets them into the room.
- **Clean up unsaved takes from other episodes on this browser.** Deferred. Each room's takes sit in their own private folder and only that room lists them, but nothing removes another episode's leftovers; the browser evicts them until the dashboard work can take that on. Removing a take after saving it still deletes that take.

## Consequences

- `showDirectoryPicker`, the unsupported-browser join gate that checks for it, and the folder explainer go away. After the display name, the next step is the mic.
- The leave warning, the one-time upload-failure alert, and the post-stop upload wait can no longer say the recording is already saved on this device before the person has saved. The upload wait cannot sit in front of Save.
- A private file the person has not saved is not a WAV they can attach. The server copy is still what the host uses when it succeeded.
