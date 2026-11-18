// Exact identity of a final-delivery create request. Every run of an intent
// shares one intent branch, so a closed or merged pull request on it is this
// run's own only if it carries this run's marker. The marker is random: it
// carries no intent, project, user or credential data. Final delivery persists
// it on the repository row in the fenced write that records the create request,
// writes it into the pull request description, and the provider-side inspection
// reads it back. Timestamps and list order never establish ownership.
import { randomBytes } from 'node:crypto';

const MARKER = /aidlc-delivery-[0-9a-f]{32}/g;

export const newDeliveryMarker = () => `aidlc-delivery-${randomBytes(16).toString('hex')}`;

// A trailing HTML comment: hidden where the description renders Markdown, and
// never something a reviewer has to edit.
export const withDeliveryMarker = (body, marker) =>
  `${body ?? ''}\n\n<!-- aidlc-delivery: ${marker} -->`;

export const deliveryMarkers = (text) => [...new Set(String(text ?? '').match(MARKER) ?? [])];
