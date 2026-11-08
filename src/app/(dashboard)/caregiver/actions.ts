"use server";

/**
 * Caregiver_Dashboard Known_Contact actions (Req 9.5, 9.6, 9.7).
 *
 * Thin revalidating wrappers around the shared
 * {@link addKnownContact} / {@link removeKnownContact} Server Actions in
 * `src/app/actions/known-contacts.ts`. The shared actions own all validation,
 * Care_Link scoping, and persistence and stay free of routing concerns; these
 * wrappers add the dashboard-specific `revalidatePath` so the server
 * re-renders the updated Known_Contacts list after a successful mutation.
 *
 * On failure the wrapped action returns its typed failure result unchanged and
 * no revalidation occurs, so the prior list stays on screen (Req 9.7). Exports
 * are arrow-function consts with named exports (workspace Next.js rules).
 */

import { revalidatePath } from "next/cache";
import {
  addKnownContact as addKnownContactAction,
  removeKnownContact as removeKnownContactAction,
  type ActionResult,
  type AddKnownContactInput,
  type RemoveKnownContactInput,
} from "@/app/actions/known-contacts";

/** The route whose RSC data is revalidated after a successful mutation. */
const CAREGIVER_DASHBOARD_PATH = "/caregiver";

/**
 * Adds a Known_Contact, then revalidates the caregiver dashboard on success so
 * the updated list re-renders (Req 9.5). A failure result is returned as-is and
 * nothing is revalidated, preserving the prior list (Req 9.7).
 */
export const addKnownContact = async (
  input: AddKnownContactInput,
): Promise<ActionResult> => {
  const result = await addKnownContactAction(input);
  if (result.ok) revalidatePath(CAREGIVER_DASHBOARD_PATH);
  return result;
};

/**
 * Removes a Known_Contact, then revalidates the caregiver dashboard on success
 * so the updated list re-renders (Req 9.6). A failure result is returned as-is
 * and nothing is revalidated, preserving the prior list (Req 9.7).
 */
export const removeKnownContact = async (
  input: RemoveKnownContactInput,
): Promise<ActionResult> => {
  const result = await removeKnownContactAction(input);
  if (result.ok) revalidatePath(CAREGIVER_DASHBOARD_PATH);
  return result;
};
