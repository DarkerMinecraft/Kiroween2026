"use client";

/**
 * Known_Contact add/remove controls for the Caregiver_Dashboard (Req 9.5, 9.6,
 * 9.7).
 *
 * This is the only `"use client"` surface of the caregiver dashboard; the
 * lists and status render on the server (workspace rule: minimal `use client`).
 * It wires the shadcn/ui + Radix dialog and buttons to the
 * {@link addKnownContact} / {@link removeKnownContact} Server Actions. On
 * success the server revalidates the page via `revalidatePath` so the updated
 * list re-renders; on failure the prior list stays on screen untouched and a
 * `sonner` toast describes the error (Req 9.7).
 *
 * Exports are arrow-function consts with named exports (workspace Next.js
 * rules).
 */

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addKnownContact,
  removeKnownContact,
} from "@/app/(dashboard)/caregiver/actions";
import type { ActionResult } from "@/app/actions/known-contacts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** A Known_Contact row the manager can remove. */
export interface KnownContactItem {
  readonly id: string;
  readonly e164Number: string;
  readonly displayName: string | null;
}

/** Props for {@link KnownContactsManager}. */
export interface KnownContactsManagerProps {
  /** The authenticated Caregiver's `User.id`, forwarded to the server actions. */
  readonly caregiverUserId: string;
  /** The selected `SeniorProfile.id` the contacts belong to. */
  readonly seniorId: string;
  /** The current Known_Contacts, rendered server-side and passed in as props. */
  readonly contacts: readonly KnownContactItem[];
}

/**
 * Renders the Known_Contacts list with a remove control per row and an
 * add-contact dialog. State lives on the server: a successful action triggers a
 * `revalidatePath`, so this component holds only transient form/dialog state.
 */
export const KnownContactsManager = ({
  caregiverUserId,
  seniorId,
  contacts,
}: KnownContactsManagerProps) => {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isPending, startTransition] = useTransition();

  // Surfaces a typed action result as a toast; only the failure path shows an
  // error, and the prior list is preserved because no local state mutated.
  const reportResult = (result: ActionResult, successMessage: string): boolean => {
    if (result.ok) {
      toast.success(successMessage);
      return true;
    }
    toast.error(result.message);
    return false;
  };

  const handleAdd = () => {
    startTransition(async () => {
      const result = await addKnownContact({
        caregiverUserId,
        seniorId,
        number,
        displayName: displayName.trim() === "" ? undefined : displayName,
      });
      if (reportResult(result, "Contact added")) {
        setNumber("");
        setDisplayName("");
        setOpen(false);
      }
    });
  };

  const handleRemove = (contactId: string) => {
    startTransition(async () => {
      const result = await removeKnownContact({
        caregiverUserId,
        seniorId,
        contactId,
      });
      reportResult(result, "Contact removed");
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Known contacts</h3>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button size="sm" variant="outline">
                Add contact
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add known contact</DialogTitle>
              <DialogDescription>
                Calls from this number connect straight through without
                screening.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="known-contact-number">Phone number</Label>
                <Input
                  id="known-contact-number"
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  placeholder="+1 555 123 4567"
                  autoComplete="tel"
                  inputMode="tel"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="known-contact-name">Display name (optional)</Label>
                <Input
                  id="known-contact-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Dr. Alvarez"
                  maxLength={100}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleAdd}
                disabled={isPending || number.trim() === ""}
              >
                Add contact
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No known contacts yet. Every caller will be screened.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {contacts.map((contact) => (
            <li
              key={contact.id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {contact.displayName ?? contact.e164Number}
                </p>
                {contact.displayName ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {contact.e164Number}
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleRemove(contact.id)}
                disabled={isPending}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
