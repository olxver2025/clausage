# Subscription value

Claude and Codex plans are detected automatically from the existing account plan types used by **Blocks & limits**. No manual setup is needed when the plan is reported. Optional fallbacks and price overrides live in **Settings → Subscriptions**. Overview’s **Your money’s worth** panel shows today’s API-equivalent inference value, calendar-month-to-date value, the multiple of the full monthly fee, and how much value is above or still needed to cover that fee. For example, $300 of inference against a $100 monthly fee is 3× the fee and $200 above it.

The comparison always requests calculated model costs, including cache and supported service-tier pricing, even when the dashboard uses Recorded only. It always uses the current calendar month in the selected timezone, independently of the dashboard date range. Tool, computer, project and subagent filters still apply; partial usage is labelled. Missing model prices and historical estimates are flagged. Historical aggregates retain their source’s UTC dates, as in other reports.

Detected plan types are matched to the pricing catalog. Claude `max` maps to Max at $100/month and `ultra` maps to Ultra at $200/month. Exact tiers use their list price; broad types such as Codex `pro` show a price and value range rather than assuming a tier. The metadata does not report the user’s actual invoice, tax, discounts or billing cadence. No new authentication or account endpoint is introduced; Claude’s existing opt-in limits setting is respected. Optional overrides are stored in this browser under `clausage-subscriptions-v1`, shared between its tabs. The same existing plan metadata powers the limits and value cards. Annual billing uses the annual invoice divided by 12; it does not use rounded advertised monthly equivalents. A USD/month override supports regional prices, taxes, promotions, extra paid usage, existing contracts and custom subscriptions for every tool. Team prices refer to one seat, to match personal local logs. Do not assign the same fee to multiple tools for a shared subscription.

## Pricing snapshot

Checked **15 November 2026**, standard US USD list prices. These are a checked-in catalog, not an automatic price feed. Every preset links to its official source in Settings. Unknown, negotiated, and usage-dependent totals require an explicit cost instead of assuming zero. Introductory offers are excluded.

| Provider | Current presets | Official source |
| --- | --- | --- |
| ChatGPT / Codex | Free $0; Go $8; Plus $20; Pro 100 $100; Pro 200 $200; Pro 500 $500; Business $25/seat monthly or $240/year; Enterprise and Edu quoted | [Pricing](https://learn.chatgpt.com/docs/pricing), [Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers) |
| Claude | Free $0 (no Claude Code); Pro $20 or $200/year; Max $100; Ultra $200; Team Standard $25/seat or $240/year; Team Premium $125/seat or $1,200/year; Enterprise total requires entry ($20/seat/month annually plus API usage, 20-seat minimum); Education quoted | [Pricing](https://claude.com/pricing) |
| Grok Build | Free $0; Plus $8; Premium $30; Super $100; Ultra $200; Teams from $30/seat (actual price required); Enterprise quoted | [Pricing](https://x.ai/pricing) |
| Google / Gemini | Free $0; AI Plus $4.99; AI Pro $19.99; AI Ultra 5× $99.99; AI Ultra 20× $199.99; existing Enterprise / Code Assist contracts entered manually | [US subscriptions](https://gemini.google/us/subscriptions/?hl=en), [Code Assist retirement](https://docs.cloud.google.com/gemini/docs/codeassist/sunset) |
| OpenCode | Go $10; Go Plus $40; Go Teams $20/member | [Go documentation](https://opencode.ai/docs/console/go/) |
| GitHub Copilot | Free $0; Pro $10; Pro+ $39; Max $100; Business / Enterprise quoted (enter your seat cost) | [Plans](https://github.com/features/copilot/plans) |

Business/enterprise editions of Gemini’s chat app do not establish Gemini CLI entitlement. Google AI Plus eligibility is also called out in the UI. Code Assist Standard and Enterprise stopped being sold on 9 October 2026; use the contract override for existing seats. Hermes, OpenClaw and Pi use their underlying model provider’s billing, so offer custom entries rather than invented tool subscriptions. OpenCode’s metered inference is covered by the “Not subscribed / API billing” option. Amp, Qwen Code and Aider bill through credits or the underlying model provider, so they also take custom entries only.

## Interpretation

API-equivalent value is a counterfactual price comparison, not actual savings, the provider’s internal inference cost, a credit balance or guaranteed included usage. API prices do not determine subscription limits. Chat, image/video generation, and other unlogged benefits are excluded. Logs do not reliably distinguish subscription usage from API-key usage or extra charges. Only keep a detected subscription or fallback when it covers the logged usage, and include extra charges in the override when appropriate. A calendar month is not an account’s renewal cycle; midmonth plan changes are not reconstructed.
