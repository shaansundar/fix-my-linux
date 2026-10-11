# Third-party notices

## Beautiful UI

`apps/desktop/src/renderer/components/bui/`, `components/atoms/`,
`components/primitives/` and `styles/bui.css` are derived from Beautiful UI
(https://www.beautifului.dev). The 21 components are vendored from the
published source. The atoms (`Button`, `EntityChip`, `ValuePill`, `Shimmer`,
`StreamText`, `GlideMenu`) and the stylesheet were rebuilt from the site's
compiled bundle because their source is not published. Local changes:
icons route through `components/icons.tsx` (Lucide), `Button` gains a
`danger` variant, and Filter Table gains a `failed` status.

```
MIT License

Copyright (c) 2026 Shane Levine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled components

| Component | License |
|---|---|
| opencode (bundled binary) | MIT |
| lucide-react | ISC |
| Inter, JetBrains Mono (via @fontsource-variable) | SIL Open Font License 1.1 |
| glimm, liveline | MIT |
| React, Electron | MIT |
