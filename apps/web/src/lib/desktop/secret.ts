// v0.5.1 desktop keychain custody design — the TS half of moving
// API-key material out of the plaintext IndexedDB settings blob and into
// the macOS Keychain (see apps/desktop/src-tauri/src/secret.rs's own
// header for the Rust half: three thin allow-listed commands, a
// dev-loop file fallback for `tauri dev`'s ad-hoc-signing cdhash churn,
// and why the platform split lives there, not here).
//
// This module owns exactly three things: reading every secret currently
// in custody (readSecrets), writing/deleting ONE secret (writeSecret),
// and the one-time migration + custody bookkeeping a fresh hydrate()
// needs (hydrateSecrets). It never imports `../store` (store.ts dynamic-
// imports THIS module instead — see that file's own `syncSecretCustody`/
// hydrate() doc comments — so there is no import cycle to reason about;
// history/autoExport.ts, which also never imports store.ts, imports this
// module statically instead, same "leaf module, imported however each
// caller's own graph prefers" posture as every other lib/desktop/*Caps.ts
// module).
import { getInvoke } from "./tauriApi";
import { IS_DESKTOP } from "../platform/desktop";
import type { Settings } from "@jargonslayer/core/types";

/** The only Settings fields this store will ever read/write/delete —
 *  mirrors secret.rs's own ALLOWED array byte-for-byte (that's the
 *  enforcement point; this list is the TS-side source of truth it's kept
 *  in sync with by hand). */
export const SECRET_NAMES = ["apiKey", "hfToken", "sonioxKey", "deepgramKey", "agentToken"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

// A locked/unavailable Keychain must never hang app boot — hydrateSecrets
// runs on every startup, in the critical path before the store is marked
// hydrated. 3s is generous for a local Keychain Services round trip
// (typically single-digit milliseconds) while still being short enough
// that a genuinely stuck read doesn't feel like a hang to the person
// waiting on the loading screen.
const READ_TIMEOUT_MS = 3000;

/** Reads every currently-stored secret. IS_DESKTOP-gated (resolves `{}`
 *  immediately on web/iOS, never calling getInvoke() there — that throws
 *  synchronously outside a Tauri build, see tauriApi.ts's own contract).
 *  Each of the 5 names is read independently — a per-key failure (a
 *  single corrupt/ambiguous Keychain item) is silently omitted rather
 *  than failing every other, unrelated key. Absent/empty values are
 *  never included (callers treat "key missing from the returned record"
 *  and "key present with an empty string" as the same thing: not set).
 *  F3 fix (Sol MEDIUM #11, review round cited in store.ts's
 *  syncSecretCustody doc): EACH name races its OWN READ_TIMEOUT_MS timer
 *  independently (concurrently, via the Promise.all below) rather than
 *  one shared race around the whole batch — one hung item (a locked
 *  Keychain prompt stuck on a single ambiguous entry) now only excludes
 *  ITSELF instead of discarding four otherwise-good reads. */
export async function readSecrets(): Promise<Partial<Record<SecretName, string>>> {
  if (!IS_DESKTOP) return {};
  const entries = await Promise.all(
    SECRET_NAMES.map(async (name): Promise<[SecretName, string] | null> => {
      const attempt = (async (): Promise<[SecretName, string] | null> => {
        try {
          const invoke = await getInvoke();
          const value = await invoke<string | null>("secret_get", { name });
          return value ? [name, value] : null;
        } catch {
          return null; // per-key failure (including getInvoke() itself) — omit, never fail the whole read
        }
      })();
      return Promise.race([
        attempt,
        new Promise<[SecretName, string] | null>((resolve) => {
          setTimeout(() => resolve(null), READ_TIMEOUT_MS);
        }),
      ]);
    }),
  );
  const result: Partial<Record<SecretName, string>> = {};
  for (const entry of entries) {
    if (entry) result[entry[0]] = entry[1];
  }
  return result;
}

/** Writes (non-empty `value`) or deletes (empty `value`) one secret.
 *  NEVER throws — every failure (locked Keychain, denied ACL prompt,
 *  getInvoke() itself failing, an IS_DESKTOP-false call a caller forgot
 *  to guard) resolves `false` instead, so callers can fail open (leave
 *  the value in its existing IDB location, out of custody) rather than
 *  crash a settings save over a Keychain hiccup. */
export async function writeSecret(name: SecretName, value: string): Promise<boolean> {
  if (!IS_DESKTOP) return false;
  try {
    const invoke = await getInvoke();
    if (value) {
      await invoke("secret_set", { name, value });
    } else {
      await invoke("secret_delete", { name });
    }
    return true;
  } catch {
    return false;
  }
}

export interface HydrateSecretsResult {
  /** `settings` with every SECRET_NAMES field resolved to its best-known
   *  live value (IDB plaintext, a keychain value, or unchanged if
   *  neither had one) — the caller (store.ts's hydrate()) uses this
   *  directly as the live in-memory settings, regardless of custody/
   *  migration outcome below. */
  settings: Settings;
  /** Names now confirmed present in the Keychain — safe for
   *  settingsForPersist's custody-gated strip to blank going forward.
   *  Populated independently of `migratedAndClean`: a name already in
   *  custody from an EARLIER boot (nothing to migrate THIS boot) still
   *  belongs here. */
  custodyNames: SecretName[];
  /** True only when this call found plaintext secret material in the
   *  passed-in `settings` AND every one of those fields' Keychain write
   *  succeeded — the caller's cue to persist the now-fully-stripped
   *  blob immediately (cleaning the IDB plaintext). False when there was
   *  nothing to migrate (already clean) OR when at least one write
   *  failed (fail-open: the WHOLE IDB blob is left untouched this boot,
   *  including any sibling field that individually succeeded — see this
   *  module's header — so the very next hydrate() retries the same
   *  fields again, idempotently, until they all land together). */
  migratedAndClean: boolean;
}

/** Migration + custody for one hydrate() call. Reads whatever's already
 *  in the Keychain, then walks SECRET_NAMES once:
 *
 *  - `settings` HAS a plaintext value for this name: that's the pre-
 *    migration app's most recently saved value, so it WINS over any
 *    (possibly stale) existing Keychain entry — write it up,
 *    overwriting the Keychain unconditionally. This is idempotent
 *    either way (a repeat write of an already-current value is a
 *    harmless no-op), so always preferring IDB over Keychain on
 *    conflict never loses data.
 *  - `settings` has NO plaintext value but the Keychain already has one
 *    (an earlier successful migration, or a restored backup that routed
 *    straight to writeSecret — see history/autoExport.ts's
 *    restoreFullBackup): adopt it live, no write needed.
 *  - Neither has one: leave the field exactly as `settings` already had
 *    it (empty).
 *
 *  F2 fix (Sol HIGH #4, review round cited in store.ts's
 *  syncSecretCustody doc): `settings.secretDeletePending` (a name whose
 *  Keychain DELETE most recently failed — see that field's own doc,
 *  packages/core/src/types.ts) is consulted FIRST, before the walk
 *  above: retrying the delete instead of ever adopting whatever's still
 *  sitting in the Keychain for that name — which is exactly the stale
 *  value the earlier failed delete was trying to remove, and the whole
 *  reason a resurrection bug existed here. A retry that succeeds this
 *  time clears the tombstone (`secret_delete` on an already-gone entry
 *  is a harmless idempotent success either way — see secret.rs's own
 *  map_delete_result doc); one that fails again keeps it pending for the
 *  next hydrate. Every tombstoned name's raw keychainValues entry is
 *  dropped regardless of outcome, so the walk below can never adopt it;
 *  the walk's own ordinary SET path (a genuinely fresh plaintext value
 *  now sitting in `settings`) still runs afterward and, on success,
 *  clears the tombstone too — same "a later successful writeSecret set/
 *  delete for that name clears its tombstone" rule applied consistently.
 *
 *  See HydrateSecretsResult's own field docs for what each part of the
 *  return value means to the caller. */
export async function hydrateSecrets(settings: Settings): Promise<HydrateSecretsResult> {
  const keychainValues = await readSecrets();
  const merged: Settings = { ...settings };
  const custodyNames: SecretName[] = [];
  let anyPlaintextInIdb = false;
  let allWritesOk = true;

  const pendingDeletes = new Set(
    (settings.secretDeletePending ?? []).filter((name): name is SecretName =>
      (SECRET_NAMES as readonly string[]).includes(name),
    ),
  );
  for (const name of pendingDeletes) {
    const ok = await writeSecret(name, "");
    delete keychainValues[name]; // never adopt a tombstoned name's raw value below, retry succeeded or not
    if (ok) pendingDeletes.delete(name);
  }

  for (const name of SECRET_NAMES) {
    const idbValue = settings[name];
    if (idbValue) {
      anyPlaintextInIdb = true;
      const ok = await writeSecret(name, idbValue);
      if (ok) {
        custodyNames.push(name);
        pendingDeletes.delete(name); // a later successful set also clears any leftover tombstone
      } else {
        allWritesOk = false; // stays in `merged` (already idbValue) and out of custody — fail-open
      }
      continue;
    }
    const keychainValue = keychainValues[name];
    if (keychainValue) {
      merged[name] = keychainValue;
      custodyNames.push(name);
    }
  }
  merged.secretDeletePending = [...pendingDeletes];

  return {
    settings: merged,
    custodyNames,
    migratedAndClean: anyPlaintextInIdb && allWritesOk,
  };
}
