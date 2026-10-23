# Golden web fixture

A tiny Vite + TypeScript cart page used by the golden matrix. The seeded bug:
`cartTotal` ignores quantity. `.golden/` holds the tickets, reference patches and hidden
acceptance tests; the matrix never copies it into the repo the agent works on.
Run `npm run dev` for the page, `npm test` for the unit tests.
