import { createMessageAdapter } from "@slack/interactive-messages";
import { MessageAdapterOptions } from "@slack/interactive-messages/dist/adapter";
import fs from "fs";
import path from "path";
import React, { useState as reactUseState } from "react";

import {
  PheliaMessage,
  PheliaClient,
  PheliaModal,
  SlackUser
} from "./phelia-client";
import { render } from "./reconciler";

interface PheliaMessageMetadata {
  message: PheliaMessage;
  name: string;
}

export interface InteractionEvent {
  user: SlackUser;
}

export interface SubmitEvent extends InteractionEvent {
  form: { [key: string]: any };
}

export interface SelectCheckboxesEvent extends InteractionEvent {
  selected: string[];
}

export interface SelectDateEvent extends InteractionEvent {
  date: string;
}

interface PheliaMessageContainer {
  channelID: string;
  invokerKey: string;
  message: string;
  modalKey: string;
  name: string;
  props: { [key: string]: any };
  state: { [key: string]: any };
  ts: string;
  type: "message" | "modal";
  viewID: string;
}

type MessageCallback = () => PheliaMessage[];

export function interactiveMessageHandler(
  signingSecret: string,
  messages: string | PheliaMessage[] | MessageCallback,
  slackOptions?: MessageAdapterOptions
) {
  const pheliaMessages =
    typeof messages === "string"
      ? loadMessagesFromDirectory(messages)
      : typeof messages === "function"
      ? loadMessagesFromArray(messages())
      : loadMessagesFromArray(messages);

  const messageCache = pheliaMessages.reduce(
    (cache, { message, name }) => cache.set(name, message),
    new Map<string, PheliaMessage | PheliaModal>()
  );

  const adapter = createMessageAdapter(signingSecret, {
    ...slackOptions,
    syncResponseTimeout: 3000
  });

  async function processAction(payload: any) {
    const { channel_id, message_ts, view_id, type } = payload.container;
    const messageKey: string =
      type === "view" ? view_id : `${channel_id}:${message_ts}`;

    const rawMessageContainer = await PheliaClient.Storage.get(messageKey);

    if (!rawMessageContainer) {
      throw new Error(
        `Could not find Message Container with key ${messageKey} in storage.`
      );
    }

    const container: PheliaMessageContainer = JSON.parse(rawMessageContainer);

    function useState<t>(
      key: string,
      initialValue?: t
    ): [t, (value: t) => void] {
      const [_, setState] = reactUseState(initialValue);

      return [
        container.state[key],
        (newValue: t): void => {
          container.state[key] = newValue;
          setState(newValue);
        }
      ];
    }

    function useModal(key: string, modal: PheliaModal) {
      return async (props?: any) => {
        const initializedState: { [key: string]: any } = {};

        function useState<t>(
          key: string,
          initialValue?: t
        ): [t, (value: t) => void] {
          initializedState[key] = initialValue;
          return [initialValue, (_: t): void => null];
        }

        const message = await render(
          React.createElement(modal, { props, useState })
        );

        const response: any = await PheliaClient.client.views.open({
          trigger_id: payload.trigger_id,
          view: {
            ...message,
            notify_on_close: true
          }
        });

        const viewID = response.view.id;

        await PheliaClient.Storage.set(
          viewID,
          JSON.stringify({
            message: JSON.stringify(message),
            modalKey: key,
            invokerKey: messageKey,
            name: modal.name,
            props,
            state: initializedState,
            type: "modal",
            viewID
          })
        );
      };
    }

    for (const action of payload.actions) {
      await render(
        React.createElement(messageCache.get(container.name) as PheliaMessage, {
          useState,
          props: container.props,
          useModal
        }),
        {
          value: action.action_id,
          event: generateEvent(action, payload.user)
        }
      );
    }

    const message = await render(
      React.createElement(messageCache.get(container.name) as PheliaMessage, {
        useState,
        props: container.props,
        useModal
      })
    );

    if (JSON.stringify(message) !== container.message) {
      if (container.type === "message") {
        await PheliaClient.client.chat.update({
          ...message,
          channel: container.channelID,
          ts: container.ts
        });
      } else if (container.type === "modal") {
        await PheliaClient.client.views.update({
          view_id: messageKey,
          view: {
            ...message,
            notify_on_close: true
          }
        });
      }
    }

    await PheliaClient.Storage.set(
      messageKey,
      JSON.stringify({
        ...container,
        message: JSON.stringify(message)
      })
    );
  }

  async function processSubmission(payload: any) {
    const messageKey = payload.view.id;
    const rawViewContainer = await PheliaClient.Storage.get(messageKey);

    if (!rawViewContainer) {
      throw new Error(
        `Could not find Message Container with key ${messageKey} in storage.`
      );
    }

    const viewContainer: PheliaMessageContainer = JSON.parse(rawViewContainer);

    const rawInvokerContainer = await PheliaClient.Storage.get(
      viewContainer.invokerKey
    );

    if (!rawInvokerContainer) {
      throw new Error(
        `Could not find Message Container with key ${viewContainer.invokerKey} in storage.`
      );
    }

    const invokerContainer: PheliaMessageContainer = JSON.parse(
      rawInvokerContainer
    );

    function useState<t>(
      key: string,
      initialValue?: t
    ): [t, (value: t) => void] {
      const [_, setState] = reactUseState(initialValue);

      return [
        invokerContainer.state[key],
        (newValue: t): void => {
          invokerContainer.state[key] = newValue;
          setState(newValue);
        }
      ];
    }

    const executedCallbacks = new Map<string, boolean>();
    const executionPromises = new Array<Promise<any>>();

    function useModal(
      key: string,
      _modal: PheliaMessage,
      onSubmit?: (event: SubmitEvent) => Promise<void>,
      onCancel?: (event: InteractionEvent) => Promise<void>
    ): (title: string, props?: any) => Promise<void> {
      if (key === viewContainer.modalKey && !executedCallbacks.get(key)) {
        executedCallbacks.set(key, true);

        if (payload.type === "view_submission") {
          const form = Object.keys(payload.view.state.values)
            .map(key => [key, Object.keys(payload.view.state.values[key])[0]])
            .map(([key, action]) => {
              const data = payload.view.state.values[key][action];

              if (data.type === "datepicker") {
                return [action, data.selected_date];
              }

              if (data.type === "checkboxes") {
                const selected = data.selected_options.map(
                  (option: any) => option.value
                );

                return [action, selected];
              }

              return [action, data.value];
            })
            .reduce((form, [action, value]) => {
              form[action] = value;
              return form;
            }, {} as any);

          executionPromises.push(onSubmit({ form, user: payload.user }));
        } else {
          executionPromises.push(onCancel({ user: payload.user }));
        }
      }

      return async () => null;
    }

    await render(
      React.createElement(
        messageCache.get(invokerContainer.name) as PheliaMessage,
        {
          useState,
          props: invokerContainer.props,
          useModal
        }
      )
    );

    await Promise.all(executionPromises);

    const message = await render(
      React.createElement(
        messageCache.get(invokerContainer.name) as PheliaMessage,
        {
          useState,
          props: invokerContainer.props,
          useModal
        }
      )
    );

    if (JSON.stringify(message) !== invokerContainer.message) {
      if (invokerContainer.type === "message") {
        await PheliaClient.client.chat.update({
          ...message,
          channel: invokerContainer.channelID,
          ts: invokerContainer.ts
        });
      } else if (invokerContainer.type === "modal") {
        await PheliaClient.client.views.update({
          view_id: messageKey,
          view: message
        });
      }
    }

    await PheliaClient.Storage.set(
      viewContainer.invokerKey,
      JSON.stringify({
        ...invokerContainer,
        message: JSON.stringify(message)
      })
    );
  }

  adapter.viewSubmission(new RegExp(/.*/), async payload => {
    processSubmission(payload);
  });

  adapter.viewClosed(new RegExp(/.*/), async payload => {
    processSubmission(payload);
  });

  adapter.action(new RegExp(/.*/), async payload => {
    processAction(payload);
  });

  return adapter.requestListener();
}

function generateEvent(
  action: any,
  user: SlackUser
): SelectDateEvent | InteractionEvent | SelectCheckboxesEvent {
  if (action.type === "datepicker") {
    return { date: action.selected_date, user };
  }

  if (action.type === "checkboxes") {
    return {
      selected: action.selected_options.map((option: any) => option.value),
      user
    };
  }

  return { user };
}

function loadMessagesFromArray(
  messages: PheliaMessage[]
): PheliaMessageMetadata[] {
  return messages.map(message => ({ message, name: message.name }));
}

function loadMessagesFromDirectory(dir: string): PheliaMessageMetadata[] {
  const modules = new Array();

  fs.readdirSync(dir).forEach(file => {
    try {
      const module = require(path.join(dir, file));
      modules.push(module);
    } catch (error) {}
  });

  return modules.map(m => ({
    message: m.default,
    name: m.default.name
  }));
}
