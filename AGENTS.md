# Agent Guide — luca-sia/.github

## Cursor Cloud specific instructions

This is the GitHub **organisation profile** repository. It is documentation/content only:

- No package manager, application server, build system, tests, or lint tooling exist. The "codebase" is Markdown.
- The public organisation profile is published by GitHub from the profile Markdown (root `README.md` here; GitHub's convention for the rendered org profile is `profile/README.md` if/when one is added). There is nothing to compile or deploy from within the repo.
- Because there are no dependencies, the startup update script is a no-op guarded on `package.json` (`if [ -f package.json ]; then npm install; fi`). Do not add build/test steps to it.

### Previewing content locally

To view Markdown as GitHub renders it (the repo's actual product), run any Markdown previewer — it is a dev convenience, not a repo dependency, so keep it out of the repo and the update script. Node 22 and Python 3.12 are available. Example used during setup: a small Node server with `marked` + `github-markdown-css` serving the README on `http://localhost:8080`.
