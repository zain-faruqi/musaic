/**
 * View routing — a discriminated-union state plus a `navigate`
 * action. No react-router in v1; if real routing arrives later it
 * replaces this cleanly.
 *
 *
 * Why a discriminated union rather than `{ name, id? }`: the
 * `id` field is only meaningful on the playlist variant. Modeling
 * it as a union makes the "no id when home" invariant a type-level
 * fact and `App.tsx` exhaustively switches without nullable id
 * dances.
 */
import { create } from 'zustand';

export type View =
  | { readonly kind: 'home' }
  | { readonly kind: 'playlist'; readonly id: number }
  /**
   * The in-playlist "Add tracks" picker. `playlistId` is the playlist
   * being grown — the picker renders against `useLibraryStore.tracks`
   * filtered against the parent playlist's current membership, and
   * confirms via `playlist:add-tracks`.
   */
  | { readonly kind: 'add-tracks'; readonly playlistId: number };

type UIState = {
  readonly currentView: View;
  readonly actions: {
    navigate(view: View): void;
  };
};

export const useUIStore = create<UIState>((set) => ({
  currentView: { kind: 'home' },
  actions: {
    navigate(view: View): void {
      set({ currentView: view });
    },
  },
}));
