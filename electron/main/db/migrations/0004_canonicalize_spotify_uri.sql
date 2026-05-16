-- Migration 0004: canonicalize Spotify source_id from bare trackId
-- to full URI.
--
-- Background. An earlier version of
-- `electron/main/spotify/save.ts` was storing the bare 22-char
-- trackId as `source_id`. But:
--
--   - The `sourceId` invariant is "the Spotify URI"
--     (`spotify:track:<id>`), parallel to local files storing the
--     file path.
--   - SpotifyAdapter.#startPlaybackOnDevice sends
--     `{ uris: [track.sourceId] }` directly to PUT
--     /me/player/play. Spotify's API rejects bare trackIds with
--     HTTP 400 ("Invalid track uri") — it expects the URI form.
--   - The adapter's own unit tests already used the URI form for
--     `sourceId`; the bug was a save-side inconsistency.
--
-- Caught at packaged-build smoke (clicking a saved Spotify tile
-- produced the 400 from Spotify Web API). Fix is two-part: the
-- save flow now stores `parsed.uri`, and this migration
-- canonicalizes any rows persisted before that landed so the
-- post-fix code can play them.
--
-- Safety: bare trackIds are 22 chars of base62 and never start
-- with `spotify:`. The LIKE filter is unambiguous; running this
-- migration twice is a no-op because the second pass matches
-- nothing.

UPDATE tracks
   SET source_id = 'spotify:track:' || source_id
 WHERE source = 'spotify'
   AND source_id NOT LIKE 'spotify:track:%';
