# DeskGhost

The purpose of this project is to make it easier to manage several groups of personal tasks at the same time, quickly record ideas, and experiment with an Agent's ability to extend artwork and animation designs while maintaining consistency.

## The art experiment

Put simply, I create art assets to show my vision for this project's art, especially things that are difficult to express in words and require fine-tuning of colors, layouts, and so on. These are all in [assets](assets/README.md). I then ask the Agent either to use them directly or to extend their style to complete the project's artwork, without having to draw too much of it by hand.

In practice, this has proven very effective for relatively simple designs like these. The Agent helped me accurately extend almost all of the artwork. For example, with the [Setting button design](assets/SVG/tab_button_example.svg) ([Illustrator project](assets/tab_button_example.ai)), the Agent can easily change its length and width to fit different places and add different text. And with the [stickers](assets/SVG/stopped.svg), simple prompts were enough for the Agent to create wonderful sticker-peeling and sticking effects. The [peeling demo](assets/SVG/card_peel_demo.html) is also available.

Overall, this whole design process has been a lot of fun. Although the design itself is relatively simple, it has still saved a considerable amount of repetitive work. Perhaps that ideal future, where AI assists human artistic creation rather than replacing it, really is possible.

## What I did as the Agent

I turned the supplied examples into reusable interface structures, styles, and graphic layers, then extended them into button variants, card fronts and backs, tags, notes, and hooks. I implemented the sticker-peeling and sticking animations, the shadows when a card is lifted, the rising and falling leather board, and the flocking keycap particles. I kept adjusting them as the author tried the interface and pointed out what needed to change.

I also implemented the task graph interactions, local saving and recovery, shortcuts and gesture recognition, and the build and automated checks. I followed the author's visual direction and reference assets, with the author making the final design decisions. My automated checks cover some interaction and data boundaries; they do not amount to a complete human code review.

## Installation

### Download a prebuilt package

Download the Windows x64 portable package from [GitHub Releases](https://github.com/Kitsudora/DeskGhost/releases/latest). The current release is [v0.5.9](https://github.com/Kitsudora/DeskGhost/releases/tag/v0.5.9).

Extract the entire folder and run `DeskGhost.exe`. Keep all the accompanying files together. Electron and the .NET runtime are included, so you do not need to install Node.js or the .NET SDK separately. The release includes `SHA256SUMS.txt` for checking your download.

This is currently an unsigned portable application, without an installer or automatic updates. To upgrade, exit the old version normally and extract the new version into a separate folder. Workspace data is stored separately from the application folder.

### Run or build from source

You need Windows, Git, Node.js **22.12 or later**, and the **.NET 10 SDK**.

```powershell
git clone https://github.com/Kitsudora/DeskGhost.git
cd DeskGhost
npm ci
npm start
```

`npm start` builds the data service before starting the application. To build a portable package:

```powershell
npm run build
```

The output is in `artifacts/desktop/DeskGhost-win32-x64/`. The build script uses `.tools/dotnet/dotnet.exe` from the repository if present; otherwise, it uses `dotnet` from PATH.

## Shortcuts and interactions

Workspaces separate different groups of tasks. Logical time columns represent stages, not dates. Tasks created through a shortcut or the wand appear in the current workspace's latest column by default, using the category of its most recently created, non-deleted task. Connections represent where tasks come from and can branch or merge. A target always stays to the right of its sources; disconnecting removes the corresponding constraint.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+N` | Globally summon a task card and start typing |
| `Ctrl+Alt+G` | Globally open the task graph |
| `Enter` / `Ctrl+Enter` | On the front of a new card: title → description → create; clicking `Done` also creates it |
| `Shift+Enter` | Insert a line break in the description |
| `Alt+F` | Flip the card while creating or editing; choose the workspace and category or add notes on the back |
| `Alt+W` | Open the workspace tag selector while creating or editing |
| `Esc` | Close the current popup, cancel a new card draft, return to the graph, or hide the interface; edits to an existing card are saved, not undone |
| `Ctrl+F` | Find tasks in the graph |
| `Ctrl+Z` | Undo a graph operation; inside a text field, this remains a text-editing shortcut |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo a graph operation when focus is outside a text field |
| `Enter` / `F2` | Open the selected card in the graph |
| `N` | Create a card when not typing in an input field |
| `Shift` + mouse wheel | Browse time columns horizontally |
| `Ctrl` + mouse wheel / `+` / `-` | Zoom the graph, from the original size down to five cards fitting vertically |

Both global shortcuts can be changed in settings. You can create a card entirely from the front without going through tags or notes on the back. When editing an existing card, ordinary Enter inserts a line break in the description, while Ctrl+Enter confirms the edit.

| Mouse interaction | Result |
| --- | --- |
| Draw two consecutive circles in the same direction while idle, then click once | Summon with the wand: after the keycap particles gather, click to start creating; gesture difficulty is adjustable in settings |
| Move the mouse quickly while the wand is ready | Disperse the particles; the trigger speed is adjustable in settings |
| Double-click a card / empty graph space | Enlarge the card for editing / create at that position; click `Done` to finish |
| Drag a card | Move it and snap to a row and column; dragging into the new-column area on the far right adds a time column |
| Select a card, then drag a connection point | Create a connection; drag an existing endpoint to reconnect it, or release it over empty space to disconnect |
| Peel the status sticker from right to left / left to right | Advance the task status / return to the previous stage; peel upward or diagonally upward to stop the task |
| Click a paper tag on the back | Select or create a workspace or category; write notes on the separate note paper |
| Mouse wheel / hold the middle mouse button and drag | Browse vertically / pan the graph; two empty rows are reserved below, so you do not have to drag a card down to open a row first |
| Drag a card into the bin | Move it to the recycle bin; click the bin to view and restore cards |

The top bar switches between graph, category, and archive views and filters by status. Search supports title, category, and status. Archiving applies to the entire connected chain, whose tasks must all be completed or stopped; disconnect a card first if you want to archive it separately. Moving an existing card to another workspace also asks you to confirm disconnecting all of its connections. The wand is disabled while the graph is open. Particle animation and effects can be reduced or disabled in settings.

## Data storage and management

All tasks are stored locally, with no account or cloud synchronization.

- **One file per workspace:** a UTF-8 `*.deskghost.json` file containing tasks, statuses, categories, connections, logical columns, layout, notes, and archive and recycle-bin records. The current workspace format is `formatVersion: 2`.
- **Default location:** workspaces are in `%LOCALAPPDATA%\DeskGhost\Workspaces`, and settings are in `%LOCALAPPDATA%\DeskGhost\web-settings.json`. Settings can change the folder for new workspaces; already opened files stay at their existing locations.
- **Automatic saving:** edits to existing cards save automatically; new cards are created only after confirmation. Saving writes a temporary file in the same directory, then atomically replaces the main file. The previous valid contents are retained as `.bak`. Write failures are reported.
- **Backup and migration:** finish editing and exit normally, then copy the workspace files, optionally keeping their `.bak` files too. The interface provides export, Save as, and recovery from backup. Open a copied workspace file to continue using it. Copying the application folder alone does not copy your workspace data.
- **Undo and recovery:** undo and redo are kept only for the current session, with up to 50 steps per workspace and a memory budget. Deleting a card does not delete other tasks. Restoring it from the recycle bin does not restore its connections; undoing the deletion restores both.
- **Failures:** damaged, oversized, or externally modified files are refused when loading or overwriting, as appropriate. After an unexpected exit, recovery uses the last successful save or a valid backup; input that has not been submitted may be lost. Moving a card between workspaces involves two files, so an interruption may leave duplicates that need checking on both sides.

To try the application with a separate data directory:

```powershell
npm start -- --data-dir .local/demo
# Or, from the portable application folder:
.\DeskGhost.exe --data-dir D:\DeskGhostData
```

If you use a custom directory, keep specifying the same `--data-dir` when upgrading.

## License

The project's own program code uses the standard [MIT License](LICENSE), including the implementations of interactions and animations. The license text follows the version published by the [Open Source Initiative](https://opensource.org/license/mit).

**The original artwork is All Rights Reserved and is not covered by the MIT License.** This includes the artwork project files, SVGs, and example graphics in `assets/`, and the corresponding application assets in `desktop/web/assets/paper/` and `desktop/web/assets/stickers/`. The project files and outputs are still shared to show the working process; see [assets/README.md](assets/README.md). Code in the demos is covered by MIT, while the artwork in them remains covered by the artwork notice.

Third-party dependencies and fonts retain their own licenses and are not covered by the original-artwork notice. The bundled Bungee, Teko, Smiley Sans, and Orbitron fonts use the SIL Open Font License 1.1, with their licenses and [source records](desktop/web/assets/fonts/SOURCES.txt) retained. BankGothic and system Chinese fonts are not bundled.

## A little rambling

As mentioned above, the main purpose of this software is to experiment with AI's ability to extend artwork while maintaining consistency. The code is not the focus, and it has received almost no human review, so I don't particularly recommend using it directly.

