/**
 * The breakpoint below which the room swaps three columns for one region
 * at a time. RecordingRoom.svelte and RoomPresenceTable.svelte repeat this
 * width in their CSS media queries; keep them in step.
 */
export const MOBILE_ROOM_QUERY = '(max-width: 720px)'

export const MOBILE_VIEWS = [
  { id: 'tabs', label: 'Tabs' },
  { id: 'research', label: 'Research' },
  { id: 'participants', label: 'Participants' }
]
