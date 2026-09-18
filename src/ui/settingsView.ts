/**
 * Settings: the one global preference this extension has, plus a look at
 * which passages have overridden it.
 *
 * Task 0004's review chose a Settings screen inside the panel over the host's
 * Preferences (`contributes.configuration`) specifically because it sits next
 * to the per-passage override on the passage screen - a global-only Preferences
 * page could not show "3 passages have their own setting" at all.
 */

import type { AnswerMode, PlanView, SettingsView } from '../types';
import { button, el } from './dom';
import { toolbar } from './components';
import type { PanelHost } from './host';

export function renderSettings(host: PanelHost, settings: SettingsView, plan: PlanView): HTMLElement {
  const root = el('section', { class: 'sm-screen sm-screen-settings' });

  root.appendChild(toolbar({ title: 'Settings', onBack: () => host.go({ type: 'goPlan' }) }));

  root.appendChild(
    el('section', { class: 'sm-block' }, [
      el('h2', { class: 'sm-block-title', text: 'Answering blanks' }),
      renderAnswerModeGroup(host, settings.defaultAnswerMode),
      el('p', { class: 'sm-hint', text: 'Capitals and punctuation never count.' }),
    ]),
  );

  root.appendChild(renderOverrides(host, plan));

  return root;
}

function renderAnswerModeGroup(host: PanelHost, current: AnswerMode): HTMLElement {
  const name = 'sm-answer-mode-default';

  function radio(value: AnswerMode, label: string, hint: string | null): HTMLElement {
    const id = `sm-answer-${value}`;
    const input = el('input', { id, type: 'radio', attrs: { name, value } }) as HTMLInputElement;
    input.checked = current === value;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      void host.request({ type: 'setDefaultAnswerMode', mode: value }).then((reply) => {
        if (!reply.ok) host.announce(reply.error);
      });
    });

    return el('div', { class: 'sm-radio-row' }, [
      input,
      el('label', { attrs: { for: id } }, [
        el('span', { class: 'sm-radio-label', text: label }),
        hint ? el('span', { class: 'sm-hint', text: ` ${hint}` }) : null,
      ]),
    ]);
  }

  return el('div', { class: 'sm-radio-group' }, [
    radio('firstLetter', 'First letter of each word', '(quick)'),
    radio('fullWord', 'Full word, exact spelling', null),
  ]);
}

function renderOverrides(host: PanelHost, plan: PlanView): HTMLElement {
  const overridden = plan.passages.filter((pv) => pv.passage.answerMode !== null);

  return el('section', { class: 'sm-block' }, [
    el('h2', { class: 'sm-block-title', text: 'Passages with their own setting' }),
    overridden.length === 0
      ? el('p', {
          class: 'sm-block-caption',
          text: 'None yet. Change one from its own passage screen.',
        })
      : el(
          'ul',
          { class: 'sm-list' },
          overridden.map((pv) =>
            el('li', { class: 'sm-row' }, [
              el('span', { class: 'sm-row-ref', text: pv.passage.reference }),
              el('span', {
                class: 'sm-row-meta',
                text: pv.passage.answerMode === 'fullWord' ? 'Full word' : 'First letter',
              }),
              button('Change', () => host.go({ type: 'goPassage', passageId: pv.passage.id }), {
                class: 'sm-btn sm-btn-small sm-btn-quiet',
              }),
            ]),
          ),
        ),
    el('p', {
      class: 'sm-block-caption',
      text: '(Change it on each passage\'s screen.)',
    }),
  ]);
}
