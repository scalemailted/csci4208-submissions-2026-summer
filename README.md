# CSCI 4208 — Summer 2026 Student Submissions

> This repository is your course portfolio for labs and the capstone submission record.

- **Student:** <Your Name>
- **GitHub username:** <username>
- **Project board:** <optional project URL>
- **Live portfolio:** <https://USERNAME.github.io/REPOSITORY/>

## Getting started

1. Create your own repository from the instructor submission repository and keep the default branch named `main`.
2. Confirm that **Issues** and **GitHub Actions** are enabled in the repository settings.
3. Edit the student information above, commit, and push to `main`.
4. The **Seed or update summer roadmap** workflow will automatically create the current assignment Issues, milestones, labels, and the table below.
5. Enable GitHub Pages if a lab must be published as a live site.

The same workflow checks the instructor roadmap on every push and once each hour. Newly assigned work appears automatically after the instructor changes its roadmap entry to `published: true`. You may also run the workflow manually from the **Actions** tab.

## Submission status

<!-- STATUS:START -->
| Item | Key | Status |
|---|---|---|
| Lab 01 — HTML-first Interactive Game (minimal JavaScript) [#1](https://github.com/scalemailted/csci4208-submissions-2026-summer/issues/1) | `lab-01` | Open |
| Lab 02 — CSS Crash Course [#2](https://github.com/scalemailted/csci4208-submissions-2026-summer/issues/2) | `lab-02` | Open |
<!-- STATUS:END -->

## Repository layout

```text
/
├── README.md
├── labs/
│   ├── README.md
│   ├── lab-01/
│   ├── lab-02/
│   └── lab-XX/
├── capstone/
│   └── README.md
│  
└── .github/
    ├── course-source.json
    ├── scripts/
    └── workflows/
```

## Submitting a lab

1. Put the complete lab in `labs/<roadmap-key>/`, such as `labs/lab-04/`.
2. Include that lab's required entry file, source, assets, and a short `README.md`.
3. Commit and push the work.
4. Open the matching Issue, complete its acceptance checklist, and add the requested live URL or notes inside the **Student submission** section.
5. Apply `ready-for-approval` when the work is ready for the instructor.

## Submitting the capstone

The capstone application lives in its own GitHub repository. Complete `capstone/README.md` here with the external repository, deployed application, and demonstration details. Add the same links to the `capstone` Issue and apply `ready-for-approval` when it is ready.

## Issue editing rules

Each automated Issue contains an instructor-managed section and a student-submission section. Edit only the content between:

```text
<!-- student-submission:start -->
...
<!-- student-submission:end -->
```

Roadmap refreshes preserve that section, unchanged checklist selections, status labels, custom labels, and closed Issues. Instructor changes can safely update the rest of the Issue.

## Status labels

Use the labels that describe the current state of the work, especially:

`blocked` · `peer-review-requested` · `reviewed` · `changes-requested` · `ready-for-approval` · `completed` · `approved` · `deployed`

The submission table is refreshed when these labels or an Issue's open/closed state changes.

## Course source

Assignment instructions and the canonical roadmap are maintained in the [CSCI 4208 Summer 2026 course repository](https://github.com/scalemailted/CSCI4208-Summer2026).

If the instructor source is temporarily unavailable, the workflow fails without changing Issues and tries again on the next push, scheduled run, or manual run.
