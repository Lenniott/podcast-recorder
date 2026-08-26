# 07: Block on upload finish after recording stops

**What to build:** After a participant stops recording, if their local WAV is saved but the server copy is still uploading or finalizing, the app shows a blocking modal with a percentage progress bar. Leaving is warned against while the server copy is incomplete, but the copy explains that the local recording is saved and the fallback is to send it another way.

**Blocked by:** 01: Protect active local recording from exit; 05: Finalize server copy and enable host download; 06: Show server-copy percent in sidebar.

**Status:** done

**Architectural context:** The post-stop modal is about finishing the convenience server copy, not saving the recording. Copy should say the local WAV is already saved and that leaving before upload completes means the participant will need to send the local file another way. There is no resumable upload requirement.

- [x] Stopping a recording with an incomplete server copy opens a modal showing percentage remaining.
- [x] The modal clearly says the local recording is saved locally.
- [x] Closing, refreshing, changing URL, or navigating in-app while upload is incomplete triggers a warning.
- [x] The upload warning is less severe than the active-recording warning and says leaving means sending the local file another way.
- [x] The modal closes automatically when the server copy is complete.
- [x] Leaving without active recording or incomplete upload remains unblocked.
