---
seo:
  title: teaspill — durable AI agents, self-hosted
  description: AI agents that survive restarts and deploys, spawn sub-agents, and stream everything they do to your UI. Define agents in TypeScript; teaspill keeps them running.
---

::u-page-hero{class="dark:bg-gradient-to-b from-neutral-900 to-neutral-950"}
---
orientation: horizontal
---
#top
:hero-background

#title
AI agents that [outlive the process]{.text-primary}.

#description
teaspill is a self-hosted platform for durable AI agents: they survive crashes, restarts, and deploys, spawn sub-agents, and stream everything they do to your UI — live. You write TypeScript; teaspill keeps it running.

#links
  :::u-button
  ---
  to: /getting-started
  size: xl
  trailing-icon: i-lucide-arrow-right
  ---
  Get started
  :::

  :::u-button
  ---
  icon: i-simple-icons-github
  color: neutral
  variant: outline
  size: xl
  to: https://github.com/everynow-dev/teaspill
  target: _blank
  ---
  View on GitHub
  :::

#default
  :::prose-pre
  ---
  code: |
    import { defineAgent, native } from "@teaspill/agents-sdk";
    import { z } from "zod";

    export const researcher = defineAgent({
      type: "researcher",
      spawnSchema: z.object({ topic: z.string() }),
      state: z.object({ summary: z.string().optional() }),
      harness: native({
        model: "claude-sonnet-4-5",
        systemPrompt:
          "Research the topic. Spawn a summarizer with " +
          "your notes, wait, then finish with its summary.",
        ingressUrl: "http://localhost:8080",
      }),
    });
  filename: agents/researcher.ts
  ---

  ```ts [agents/researcher.ts]
  import { defineAgent, native } from "@teaspill/agents-sdk";
  import { z } from "zod";

  export const researcher = defineAgent({
    type: "researcher",
    spawnSchema: z.object({ topic: z.string() }),
    state: z.object({ summary: z.string().optional() }),
    harness: native({
      model: "claude-sonnet-4-5",
      systemPrompt:
        "Research the topic. Spawn a summarizer with " +
        "your notes, wait, then finish with its summary.",
      ingressUrl: "http://localhost:8080",
    }),
  });
  ```
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
What teaspill gives you

#features
  :::u-page-feature
  ---
  icon: i-lucide-infinity
  ---
  #title
  Durable by default

  #description
  An agent's process can die mid-run; the agent doesn't. Every step is recorded, so work resumes exactly where it stopped — no lost conversations, no repeated side effects.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-git-fork
  ---
  #title
  Multi-agent from day one

  #description
  Agents spawn sub-agents, message each other, and gather results. Delivery and ordering are guaranteed by the platform, not by plumbing you write.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-activity
  ---
  #title
  Stream everything to your UI

  #description
  Every message, tool call, and result lands on a live timeline your frontend can replay, follow token by token, or join late without missing anything.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-plug
  ---
  #title
  Pick your engine

  #description
  Run the model loop with teaspill's native engine — any provider — or with the Claude Agent SDK. Swapping is one line in the agent definition; nothing else changes.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-container
  ---
  #title
  Self-hosted, five services

  #description
  One Docker Compose file runs the whole platform: coordination, catalog, history, live sync, and the gateway. Your infrastructure, your keys, your data.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-key-round
  ---
  #title
  One front door

  #description
  Your app, your UI, and the CLI talk to teaspill through a single gateway, authenticated with API keys — plus short-lived read tokens for browsers.
  :::
::

::u-page-section{class="dark:bg-gradient-to-b from-neutral-950 to-neutral-900"}
  :::u-page-c-t-a
  ---
  links:
    - label: Quick start
      to: '/getting-started/quick-start'
      trailingIcon: i-lucide-arrow-right
    - label: View on GitHub
      to: 'https://github.com/everynow-dev/teaspill'
      target: _blank
      variant: subtle
      icon: i-simple-icons-github
  title: Run your first durable agent
  description: Boot the stack with Docker Compose, define an agent in TypeScript, and watch its timeline stream into your browser.
  class: dark:bg-neutral-950
  ---

  :stars-bg
  :::
::
