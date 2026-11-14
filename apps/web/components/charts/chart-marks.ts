"use client";

import { createRovingFocus, definePrimitive } from "@ui-sdk/core";
import { createParts } from "@ui-sdk/react/primitive";

type ChartMarksOptions = {
  onActiveChange?: (key: string | null) => void;
};

const chartMarks = definePrimitive({
  name: "chart-marks",
  options: { onActiveChange: "callback" },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter types the options
  state: (_options: ChartMarksOptions) => ({
    focused: null as string | null,
  }),
  api: (context) => {
    const roving = createRovingFocus(context, {
      slot: "mark",
      key: "focused",
      orientation: () => "horizontal",
    });
    return {
      roving,
      activate: (key: string | null) => context.options().onActiveChange?.(key),
    };
  },
  slots: (slot) => ({
    // Agents read the numbers from the report tools; the marks are only for people.
    root: slot({ attrs: () => ({ "data-agent-hidden": "" }) }),
    mark: slot<{ value: string }>({
      props: { value: "string" },
      attrs: (state, part) => ({
        tabindex: part.api.roving.tabIndex(state, part),
      }),
      on: {
        keydown: (event, { el, api }) => {
          if (el) api.roving.keydown(event, el);
        },
        focus: (_event, { api, key }) => api.activate(key),
        blur: (_event, { api }) => api.activate(null),
      },
      bind: (el, part) => part.api.roving.bind(el, part),
    }),
  }),
  agent: { actions: [] },
});

const { Root: ChartMarks, Mark: ChartMark } = createParts(chartMarks, { root: "g", mark: "g" });

export { ChartMark, ChartMarks };
