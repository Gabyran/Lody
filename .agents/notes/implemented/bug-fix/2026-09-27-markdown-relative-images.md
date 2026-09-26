# Render workspace-relative images in Markdown file previews

Status: implemented
Translation: current

## Abstract

Rendered Markdown in the session file viewer now displays workspace-relative
images through the owning file source while keeping copied and exported Markdown
as lightweight, file-backed formats.

## Problem

The rendered Markdown mode of the session file viewer passed image references
straight to the browser. A reference such as `../assets/diagram.png` was therefore
resolved against the Lody page URL instead of the owning workspace, so agent-created
Markdown documents displayed their text but not their local images.

## Decision

The viewer now resolves relative image paths against the Markdown document path,
reads the target through the active file provider, or uses Electron's
`file/resolve-local` resource URL for local raster images. Local SVG is read as
bounded text and converted to a Blob. The same resolver is used by the desktop
session viewer and the mobile project file browser. Absolute URLs, data URLs,
absolute paths, and references that escape the workspace keep their existing
behavior or remain unavailable. Temporary Blob URLs are revoked when an image or
preview unmounts. Binary images use the existing 5 MiB preview ceiling where the
transport is bounded.

This is deliberately a viewer capability. Copy as Markdown continues to omit image
bytes, and CLI `transcript.md` remains portable only when its sibling `artifacts`
directory is retained. Inlining every image as base64 was rejected because it grows
the document, burdens clipboard/token budgets, and broadens accidental data copying.

## Evidence and limits

`markdown-image-path.test.ts` covers document-relative resolution, path rejection,
and provider snapshot conversion. `session-file-content-view.test.tsx` covers
provider-backed image rendering and prevents an escaping reference from being
opened. Oxfmt passes, the two focused suites pass (39 tests), and the components
package typecheck passes after building the isolated ACP submodules required by
the workspace.

- Pull request: [#1033](https://github.com/LodyAI/Lody/pull/1033).
