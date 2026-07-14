// Lints commit messages against the Conventional Commits spec.
// See CONTRIBUTING.md for the convention; releases are automated from it.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Bodies routinely contain bullet lists, file paths and URLs that exceed
    // the default 100-char cap; the meaningful constraint is a short header.
    "body-max-line-length": [0, "always"],
    "footer-max-line-length": [0, "always"],
  },
};
