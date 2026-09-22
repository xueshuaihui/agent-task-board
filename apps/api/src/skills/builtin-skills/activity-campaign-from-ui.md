# activity-campaign-from-ui

Generate a **new** campaign from campaign UI references, then deliver an H5/Web visual-first front-end draft on a fixed stack.

## Use when
Use this skill when the user:
- provides one or more campaign/activity page screenshots
- provides a campaign design preview and wants a new campaign generated from it
- wants campaign references turned into a proposal, page architecture, or H5/Web high-fidelity draft code
- wants a structured handoff for an activity page on a fixed stack

## Do not use when
Do not use this skill when:
- the request is unrelated to campaign/activity pages
- the user only wants raw OCR
- the task requires exact locked-design export
- the user wants production-ready backend logic or hidden business rules not visible from the reference
- the user wants a delivery stack outside this skill's fixed target

## Fixed platform and stack
Always stay on this fixed delivery target:
- Platform: **H5 / Web**
- Stack: **HTML + CSS + JavaScript**

Do not output code in other stacks.

## Modes
This skill supports one skill with multiple modes.

### `analysis`
Use when the user wants to understand the reference.
Return:
- observed UI structure
- visible text
- gameplay clues
- user flow clues
- uncertainty notes

### `proposal`
Use when the user wants a new campaign idea from the reference.
Return:
- reference summary
- gameplay abstraction
- new campaign concept
- target users
- goals
- rewards and participation path
- anti-copy explanation
- visual proposal direction that reads more like an operations campaign deck than a plain memo

### `architecture`
Use when the user wants implementation planning without full code.
Return:
- page module list
- module order
- popup system
- state flow
- tracking suggestions
- delivery schema

### `delivery`
Use when the user wants code on the fixed stack.
Return:
- file structure
- `index.html`
- `styles.css`
- `main.js`
- `mock-data.js`
- visual extraction summary
- implementation notes

### `full`
Use when the user wants the full flow.
Return:
1. reference analysis
2. gameplay abstraction
3. new campaign proposal
4. page architecture
5. delivery schema
6. visual direction
7. H5/Web high-fidelity draft code

## Default mode rules
If the user does not specify a mode:
- default to `proposal` if they want a new campaign/event idea
- default to `delivery` if they explicitly ask for code
- default to `full` if they ask for both plan and code

For `delivery` and `full`, when the brief implies poster-style character focus and the page would otherwise become too long, default to a female-led, launch-ready, tab-first H5 front-end draft.

## Core job
Given one or more campaign references, do all relevant parts of the following:
1. Identify observable UI patterns
2. Separate what is observed vs inferred vs assumed
3. Abstract the gameplay and module patterns
4. Propose a **new** campaign instead of copying the reference
5. Design a buildable H5/Web page architecture
6. Generate a buildable activity mechanic and visual preset when the brief is under-specified
7. Output fixed-stack high-fidelity draft code when requested

## Output rules
Prefer practical output over broad commentary.

When possible, organize the answer using these sections:
- Reference analysis
- Observed
- Inferred
- Assumed
- Gameplay abstraction
- New campaign proposal
- Page architecture
- Delivery schema
- Visual direction
- H5/Web starter files
- Uncertainties

## Proposal presentation rule
For `proposal`, the result should feel closer to an operations campaign visual deck than a plain strategy memo.

Preferred structure:
- strong campaign name and one-line hook
- visual theme and mood direction
- hero concept and key selling point
- participation path
- reward design
- module highlights
- timeline or rollout rhythm when relevant

If the user explicitly asks for a local proposal deck and the host environment supports local execution, the skill may generate a local `.pptx` file with Python.

## Intelligent activity generation rule
When the user does not pin a specific activity family, reward interaction, or theme, do not stop at the reference activity types.

Default behavior:
- infer the target engagement goal from the reference and user brief, then generate a new but buildable campaign mechanic
- support activity families such as wheel draw, split red packet, sign-in relay, scratch reveal, flip-card memory, treasure chest unlock, collection merge, timed rush, quiz challenge, or mixed mechanics
- choose one primary mechanic and at most two supporting mechanics so the page still reads cleanly on mobile
- keep the mechanic editable through data/config instead of burying the logic only in prose copy
- avoid limiting the generated campaign to the exact activity family shown in the reference when the brief is open

Required output additions when the activity is newly generated:
- name the generated activity family clearly
- explain why it fits the brief and how it differs from the reference
- expose configurable parameters such as duration, chance count, reward cadence, milestone count, animation preset, and visual preset
- keep the page shell reusable so another generated activity can replace the current one without rewriting the whole structure

## File handoff rules
Do not append executable local file-write commands.

If the user explicitly asks for local files and the host environment supports local execution, the skill should use Python to generate artifacts on disk instead of stopping at a file structure or code-only response.

The goal is to keep the handoff clear without asking the model to generate shell or terminal instructions from screenshot-derived content.

Local delivery root:
- place all final generated files under the current execution environment's `project/` directory
- create `project/` automatically if it does not already exist
- create one additional delivery bundle directory under it, using `project/<delivery-slug>/...` rather than writing files directly into `project/`
- derive `delivery-slug` from `campaignMeta.id`, a sanitized campaign title, or a stable fallback such as `campaign-delivery`
- do not scatter final files across the workspace root, temporary folders, mixed output directories, or directly under `project/`

Mode-specific file targets:
- `analysis`: present the main result as one Markdown document such as `project/<delivery-slug>/campaign-analysis.md` when local artifacts are written
- `proposal`: present the main result as one Markdown document such as `project/<delivery-slug>/campaign-proposal.md` when local artifacts are written
- `proposal` optional local artifact: `project/<delivery-slug>/campaign-proposal.pptx` when the user explicitly asks for a local visual deck and Python execution is available
- `architecture`: present the main result as one Markdown document such as `project/<delivery-slug>/campaign-architecture.md` when local artifacts are written
- `delivery`: present the generated front-end files as `project/<delivery-slug>/index.html`, `project/<delivery-slug>/styles.css`, `project/<delivery-slug>/main.js`, and `project/<delivery-slug>/mock-data.js`
- `full`: present the planning content as one Markdown document such as `project/<delivery-slug>/campaign-full.md`, and present the front-end files as `project/<delivery-slug>/index.html`, `project/<delivery-slug>/styles.css`, `project/<delivery-slug>/main.js`, and `project/<delivery-slug>/mock-data.js`
- when a hero image asset is used in `delivery` or `full`, reserve `project/<delivery-slug>/image/` and point the code to `./image/bg.png`

Handoff requirements:
- label each file clearly in the response body
- keep file names and section order aligned with the response body
- when the mode includes multiple files, provide each file's full content in its own clearly labeled section
- when local artifacts are generated with Python, report the exact file names and paths in plain language
- when the user explicitly asked for local output, do not stop after showing file structure or code blocks; confirm that the files were actually written under `project/<delivery-slug>/`
- if the user explicitly asks how to save the files locally, describe the file names and where the content belongs in plain language rather than generating executable commands
- when the delivery uses a generated hero image, include an explicit asset note that tells the user to rename the generated image to `bg.png`, keep it as PNG, and place it in `project/<delivery-slug>/image/`

## Python local output contract
When local artifacts are generated with Python:
- resolve the final output root as `project/<delivery-slug>/`
- create `project/` first, then create `project/<delivery-slug>/`, then create `project/<delivery-slug>/image/`, for example with `Path(exec_root, "project", delivery_slug, "image").mkdir(parents=True, exist_ok=True)`
- place every final delivery file under `project/<delivery-slug>/`
- keep front-end image references at `./image/bg.png`
- save, move, or copy the generated hero asset into `<output_root>/image/bg.png` before reporting success
- do not leave the generated image only in a temporary directory, the workspace root, under bare `project/`, or outside `project/<delivery-slug>/`
- when additional generated images are needed, keep them under the same `project/<delivery-slug>/image/` directory with stable names
- ensure the generated files are readable by default and that directory creation does not depend on manual pre-setup
- if `project/` was not created, or `project/<delivery-slug>/` was not created, or `project/<delivery-slug>/image/` was not created, or `bg.png` was not saved into it, treat the Python local delivery as incomplete

## Anti-copy rules
Do not simply restyle the reference.

The new campaign must change at least **2 of these 4 dimensions**:
1. campaign theme
2. reward design
3. task structure
4. module order or core interaction

Do not preserve all of the following at the same time:
- same hero structure
- same gameplay loop
- same reward chain

Call out the main changes briefly in the proposal.

## Reference-to-theme translation rules
Treat the reference as a source for **structure, interaction pattern, density, and campaign rhythm** first, and as a source for **visual style** only when it fits the user's target theme.

Use this decision rule:
- If the target campaign theme is close to the reference theme, you may inherit the reference's palette and styling direction.
- If the target campaign theme is different from the reference theme, keep the useful structure and interaction cues, but rebuild the visual style around the **target** theme.

When the target theme and reference theme conflict:
- prioritize the target festival, season, brand tone, and audience mood
- borrow layout logic, gameplay framing, and information hierarchy from the reference
- do not carry over mismatched seasonal colors or decorative symbols by default

Example:
- if the reference looks like a Spring Festival page with red and gold styling, but the new brief is for a Dragon Boat Festival campaign, do **not** keep the page red by default
- instead, keep the helpful campaign structure, then shift the visual direction toward Dragon Boat Festival cues such as bamboo green, jade green, lake blue, rice dumpling motifs, rope textures, water-wave shapes, or cooler early-summer contrast

## Confidence rules
Always separate content into these layers when relevant:
- **Observed**: directly visible from the reference
- **Inferred**: likely based on common campaign patterns
- **Assumed**: filled in because the reference is incomplete

If text is blurry or a state is hidden, say so directly.

## Delivery file rules
For `delivery` and `full`, default to this file set:
- `index.html`
- `styles.css`
- `main.js`
- `mock-data.js`

Project-root asset directory when the page uses generated imagery:
- `project/<delivery-slug>/image/`

Default first-screen visual artifact when the page is poster-led or character-led and image generation is available:
- `project/<delivery-slug>/image/bg.png`

If the user explicitly asks for local front-end files and the host environment supports local execution, the skill should use Python to write these files directly to `project/<delivery-slug>/`.

File responsibilities:
- `index.html`: page structure, visible module internals, decorative wrappers, and realistic launch-style copy
- `styles.css`: design tokens, background atmosphere, section chrome, CTA styling, popup styling, and responsive behavior
- `main.js`: render repeating data, event binding, state updates, popup control, activity-specific triggers, and lightweight view-state changes
- `mock-data.js`: campaign meta, tasks, prizes, CTA text, popup data, activity config, animation preset data, and enough mock content to render a visually complete first screen
- `image/bg.png`: generated hero visual asset focused on the woman and theme atmosphere, without embedding lower-page reward modules, task grids, or rule panels

## Top visual asset generation

For `delivery` and `full`, when the page depends on a poster-style first screen and the user does not provide a finished key visual, the skill should generate one original top visual asset before front-end delivery if the host environment supports image generation.

Mandatory trigger:
- set `need_image = true` when the brief, references, or user wording clearly imply a poster-led first screen, a female-led hero, a generated first-screen visual, or an image-first activity page
- do not treat poster-led hero generation as optional once `need_image = true`

Default contract:
- generate one real hero visual asset for the woman and use `./image/bg.png` as the code-facing path
- if the host image tool only emits a flat file such as `image.png`, treat that as a temporary output and convert the handoff target to `./image/bg.png`
- the generated asset should focus on the adult female lead, theme-matched props, lighting, and festive atmosphere instead of reproducing page modules from the reference
- when the user provides festive campaign references, borrow their palette, density, wardrobe direction, and decorative mood for the hero background atmosphere, but do not copy their prize panels, invitation boards, task modules, or page text into the generated image
- place `./image/bg.png` in the first visible hero block at the top of the page

Execution gate:
- before writing `index.html`, `styles.css`, `main.js`, or `mock-data.js`, call the host image generation tool to create the hero image asset
- if the host exposes a concrete tool such as `image_generate`, call it directly instead of describing the step abstractly
- do not claim success just by mentioning `./image/bg.png` in code or prose
- the run is incomplete unless the hero image asset for `./image/bg.png` was generated in the current run when `need_image = true`

Regeneration policy:
- default to `regenerate_each_run`
- if the same input is run again and `need_image = true`, generate a new hero image again by default
- reuse an existing `./image/bg.png` only when the user explicitly asks to reuse the existing asset

Constraints:
- generate one original adult female hero image
- prioritize a photorealistic commercial-poster result rather than an illustrated, anime, or plastic-CGI result
- image direction should prioritize theme-matched wardrobe, dominant colors, accessories, props, styling, and background atmosphere
- emphasize realistic skin texture, natural facial asymmetry, believable hand anatomy, fabric folds, hair strands, and coherent light direction
- keep the asset focused on the woman and atmosphere, not on page UI modules
- use a glamorous, attractive, stylish, slightly sexy commercial campaign poster direction
- do not generate a male hero by default
- default to one adult woman unless the user explicitly asks for multiple figures
- do not generate explicit sexual content, nudity, fetish styling, or pornographic framing
- do not embed readable prize tables, invitation reward boards, task cards, rules sections, or full-page screenshot layouts into the generated hero asset
- do not reproduce the reference woman's exact face, hairstyle, expression, pose, camera angle, or outfit details
- treat the reference as styling inspiration, not as an identity template
- do not imitate a recognizable spokesperson or celebrity-like likeness from the reference
- if image generation is unavailable or the image tool fails when `need_image = true`, clearly report that the run is blocked and stop instead of downgrading to placeholders, gradient-only heroes, or image slots without a generated asset

Quality gate:
- if the generated woman has uncanny anatomy, broken hands, duplicated props, waxy skin, incorrect eye direction, or obviously synthetic poster artifacts, regenerate before treating the run as complete
- prefer prompt language that pushes toward photorealistic commercial photography, cinematic rim light, realistic textile detail, and believable facial depth
- avoid prompt language that biases toward cartoon, illustration, doll-like beauty filters, flat 3D render, or over-smoothed skin

Required handoff note:
- after delivering code that references `./image/bg.png`, include a clear plain-language note such as `需要把生成好的图片，改名为bg，图片类型为 png，放到 project/<delivery-slug>/image 目录下`

## Female-led hero default

For character-led campaign delivery, the default first-screen visual should use one adult female hero figure as the dominant visual focus.

Requirements:
- the hero figure must be an adult woman
- the first visible block in the page should be the hero image rather than a text-only header placed above it
- do not replace the hero with a male figure by default
- do not generate mixed-gender hero focus unless the user explicitly asks for it
- the wardrobe, dominant colors, accessories, props, and styling must match the campaign theme
- if the campaign is festival-based, the character styling should visibly reflect that festival rather than using a generic outfit
- prioritize glamour, attractiveness, confidence, and poster-like visual appeal
- allow stylish and slightly sexy commercial-fashion styling for stronger attention
- keep the result within public campaign standards: no nudity, no explicit sexual pose, no fetish styling, and no pornographic framing
- the female figure should remain the main first-screen anchor, with `./image/bg.png` or an equivalent top poster block placed above summary modules, tabs, and lower content

## Character innovation rule

When generating a new female hero from campaign references:
- use the reference for color mood, seasonal styling, ornament density, and glamour level
- generate a new woman with distinct facial features, hair treatment, pose, expression, and outfit detail changes
- do not preserve the same face, same pose, same camera crop, or same two-person composition unless the user explicitly asks for that structure
- when the reference contains two women but the user only asks for a female hero image, default to one new woman instead of recreating the dual-character arrangement

Theme examples:
- Spring Festival: red as the dominant color, with gold accents, festive dress or qipao-inspired styling, lanterns, knots, and warm holiday accessories
- Dragon Boat Festival: bamboo green, jade green, lake blue, lighter summer styling, rope knots, leaf textures, and seasonal props
- Valentine-style campaign: rose red, wine red, blush pink, elegant fitted styling, floral or gift-box props

## H5 length control rule

Do not default to a full top-to-bottom stack for every module.

Prefer a tab-first H5 layout when any of the following is true:
- there are more than 5 major modules
- the page includes task lists, prize pools, records, and long rules together
- the default layout would likely become an overly long mobile page

In these cases:
- keep the first screen focused on hero + core action + one key summary module
- move secondary content into sticky tabs
- render only the active tab panel by default
- place verbose rules, records, and explanations in popups, drawers, or accordions when appropriate
- use tabs as a page-shortening strategy, not as a cosmetic decoration

## Animation choreography rule
For reward-led and interactive campaign pages, motion is part of the delivery contract rather than a last-minute decoration.

Minimum choreography:
- include 1 signature interaction animation tied to the main activity mechanic
- include 2 supporting ambient or feedback motion layers
- keep motion performant with transform/opacity-first implementation where possible
- provide a `prefers-reduced-motion` fallback or equivalent lower-motion behavior

Activity-specific defaults:
- wheel draw / lottery: wheel acceleration and deceleration, pointer bounce, winning sector glow, result popup rise-in
- split red packet: envelope crack or unfold, coin burst, amount count-up, sparkle or confetti drift
- sign-in / check-in: stamp press, calendar highlight or flip, streak beam, reward badge pop-up
- generic reward reveal: card flip, gift-box open, ribbon sweep, badge settle, counter roll-up

Creative interaction options when the brief is open:
- scratch-card reveal
- flip-card memory combo
- treasure chest unlock
- lantern or wish-drop release
- route runner or treasure-map advance
- puzzle merge or collection synthesis

Do not add motion randomly; tie it to reward feedback, task progress, CTA emphasis, and popup states.

## Delivery schema guidance
Prefer a schema that covers both campaign config and page delivery contract.

Typical sections:
- `campaignMeta`
- `hero`
- `activityFactory`
- `activityConfig`
- `tasks`
- `rewards`
- `lottery`
- `modules`
- `popups`
- `animationSystem`
- `visualPreset`
- `assetOutput`
- `stateMachine`
- `tracking`

## Important constraints
- Stay on H5/Web + HTML/CSS/JS only
- Never pretend uncertain text is exact
- Never invent backend endpoints
- Never claim pixel-perfect parity from a blurry image
- Favor reusable modules and editable data structures

## Visual fidelity rules
For `delivery` and `full`, default to a **high-fidelity visual draft**, not a low-fidelity wireframe.

Before writing code, extract the screenshot's likely visual language in 4 to 8 short bullets:
- palette and contrast style
- hero composition
- decoration density
- card or panel treatment
- CTA style
- icon/badge/tag style
- popup tone
- overall mood keywords

Then make the code reflect that visual language directly.

When the reference clearly uses poster-led artwork or rich scene imagery, explicitly decide whether the first screen should rely on a real image asset, a background plate, or both. Do not downgrade that into a text-first hero with only gradient fills.

But do not follow the screenshot's visual language blindly.

Use this priority order for visual decisions:
1. explicit user brief and target campaign theme
2. target holiday/season/brand tone
3. reference layout and interaction cues
4. reference palette and decorative styling

If the reference palette conflicts with the new campaign brief, say so briefly and switch to a target-appropriate palette.
In that case, the visual extraction summary should separate:
- reusable structural cues from the reference
- replaced visual cues that should be rebuilt for the new theme

（尾部章节「Launch-ready front-end quality rule」超长，迁移时裁剪）
