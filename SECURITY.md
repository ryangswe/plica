# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use **Report a vulnerability** on this repository's
[Security tab](https://github.com/ryangswe/plica/security) (GitHub's private vulnerability reporting).

Say what you found, how to reproduce it (a small file that triggers it is ideal) and which version or commit you
used. One person maintains Plica, so a fix can take a while.

## What counts

Plica opens files that may come from anywhere, so it treats their content as untrusted. A problem is anything
where opening a file can:

- run a script, or get HTML past the sanitizer;
- load a remote image, font or page before you chose **Load once** or **Always load**;
- make Plica open a network connection or another program without you clicking something;
- read or show a local file the opened file doesn't reference, or write any file.

## How Plica protects you, so you can judge a report

- Everything from a file is sanitized with DOMPurify or set as plain text. The app's Content Security Policy
  allows scripts from the app itself only, and the browser tests fail on any policy violation.
- HTML files preview in a sandboxed frame with its own stricter policy.
- Remote URLs in images, media and SVG are removed before anything is created, and restored only when you allow
  remote images.
- Plica sends no telemetry and checks for no updates. Links open only when you click them.

## Supported versions

The latest release only.
