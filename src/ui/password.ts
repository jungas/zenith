/**
 * The password prompt for an encrypted statement.
 *
 * Statements from Philippine banks arrive locked, so this is the first thing
 * that happens after a file is chosen and nothing proceeds until it is
 * answered: the dialog resolves with a password or with `null`, and `null`
 * cancels the import outright. There is no "continue without" path, because
 * there is nothing to continue to — an encrypted PDF yields no text at all
 * until the right key opens it.
 *
 * The password is passed straight to the parser and never stored, logged or
 * defaulted. It is not put in the state, so it cannot reach localStorage or a
 * backup export.
 */

import { h, mount } from './dom.ts';
import { openModal, close as closeModal } from './modal.ts';
import { field, input } from './components.ts';
import { icon } from './icons.ts';

export interface PasswordPromptOptions {
  fileName: string;
  /** Shown after a rejected attempt. */
  error?: string | null;
  /** The bank the statement appears to be from, when we could tell. */
  issuer?: string | null;
}

/**
 * Hints about what the password usually is.
 *
 * Every Philippine issuer sets its own rule and none of them say so on the
 * statement itself, so the reminder has to come from somewhere — and a wrong
 * guess costs a retry rather than anything worse. These are prompts to jog the
 * memory, deliberately worded as "often", not instructions.
 */
const ISSUER_HINTS: Record<string, string> = {
  BDO: 'BDO often uses the last 4 digits of your card number, or your birth date as MMDD.',
  BPI: 'BPI often uses your birth date as MMDDYYYY, or the last 4 digits of your card.',
  UnionBank: 'UnionBank often uses the last 4 digits of your card number.',
  RCBC: 'RCBC often uses your birth date as MMDDYYYY.',
  Metrobank: 'Metrobank often uses the last 4 digits of your card number.',
  'Security Bank': 'Security Bank often uses your birth date as MMDDYY.',
  PNB: 'PNB often uses your birth date as MMDDYYYY.',
  Citi: 'Citi often uses your birth date as DDMMYYYY.',
  HSBC: 'HSBC often uses your birth date as DDMMYYYY.',
};

const GENERIC_HINT =
  'Statement passwords are usually your birth date or the last digits of your card or account number. Check the email the statement came with.';

/**
 * Ask for the password. Resolves with what was typed, or `null` if the person
 * cancelled — in which case the import stops.
 */
export function askForPassword({
  fileName, error = null, issuer = null,
}: PasswordPromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const passwordInput = input({
      type: 'password',
      placeholder: 'Statement password',
      autocomplete: 'off',
      // Off, all of them: a statement password is not a site login, and the
      // browser offering to remember it here would be wrong.
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      required: true,
    });

    const errorSlot = h('div.form-error-slot');
    const showError = (message: string): void => {
      mount(errorSlot, h('p.form-error', null, icon('alert', { size: 15 }), h('span', { text: message })));
    };

    const submit = (): void => {
      const value = passwordInput.value;
      if (!value) {
        showError('Enter the password that opens this statement.');
        passwordInput.focus();
        return;
      }
      finish(value);
      closeModal();
    };

    const body = h(
      'form.form',
      {
        onsubmit: (event: Event) => {
          event.preventDefault();
          submit();
        },
      },
      h(
        'div.inline-note',
        null,
        icon('info', { size: 16 }),
        h('p', {
          text: `“${fileName}” is password protected. Zenith needs the password to read it — it is used here and now, and never saved.`,
        }),
      ),
      field('Password', passwordInput, {
        id: 'pdf-password',
        hint: issuer ? ISSUER_HINTS[issuer] ?? GENERIC_HINT : GENERIC_HINT,
      }),
      errorSlot,
    );

    if (error) showError(error);

    openModal({
      title: 'Password required',
      size: 'sm',
      body,
      footer: [
        h('div.foot-spacer'),
        h('button.btn', {
          type: 'button',
          text: 'Cancel',
          onclick: () => {
            finish(null);
            closeModal();
          },
        }),
        h('button.btn.btn-primary', { type: 'button', text: 'Unlock', onclick: submit }),
      ],
      // Closing the dialog any other way — Escape, the backdrop, the X — is a
      // cancellation, not a silent skip.
      onClose: () => finish(null),
    });

    passwordInput.focus();
  });
}
