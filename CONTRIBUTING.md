# Contributing to Database Manager for VS Code

Thank you for your interest in contributing! This guide will make the process simple and straightforward.

## How to Contribute (Step by Step)

### 1. Fork the Repository
Click the **"Fork"** button in the top-right corner of this page. This creates a copy of the project in your account.

### 2. Clone Your Fork
```bash
git clone https://github.com/YOUR-USERNAME/vscode-db-manager.git
cd vscode-db-manager
```

### 3. Create a Branch
Use a descriptive name for your feature or fix:
```bash
git checkout -b feature/feature-name
# or
git checkout -b fix/bug-name
```

**Example names:**
- `feature/add-mongodb-support`
- `fix/mysql-connection-issue`
- `docs/improve-readme`

### 4. Make Your Changes
- Write clean, commented code
- Test your changes locally
- Follow the existing code style

### 5. Commit Your Changes
```bash
git add .
git commit -m "feat: Added MongoDB Support"
```

**Commit format (optional but appreciated):**
- `feat:` New Feature
- `fix:` Bug Fix
- `docs:` Documentation Changes
- `refactor:` Code Refactoring
- `chore:` Maintenance Tasks, Dependencies, Tooling

### 6. Push to Your Fork
```bash
git push origin feature/feature-name
```

### 7. Open a Pull Request
1. Go to your fork on GitHub
2. Click **"Compare & pull request"** (appears automatically)
3. Describe what you did and why
4. Click **"Create pull request"**

**And you're done!** I'll review and provide feedback.

## Guidelines

### What we're looking for
- Well-tested code
- Clear descriptions in PRs
- One commit per feature (can squash if needed)
- Respect for existing code style

### What to avoid
- Very large PRs (split into smaller parts)
- Code without tests when applicable
- Changes without description

## Reporting Bugs

Found a bug? Open an [issue](../../issues/new) with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Screenshots (if applicable)

## Suggesting Features

Have an idea? Open an [issue](../../issues/new) with:
- Feature description
- Use cases
- Mockups or examples (if applicable)

## Need Help?

- Open an [issue](../../issues/new) with your question
- Leave a comment on the PR if you get stuck
- Check the [VSCode documentation](https://code.visualstudio.com/api)

## Keeping Your Fork Updated

If the original repository has been updated:
```bash
# Add the original repository as remote (only do once)
git remote add upstream https://github.com/martimmpr/vscode-db-manager.git

# Update
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

## Code of Conduct

Be respectful, constructive, and professional. Everyone is welcome regardless of experience, identity, or background.

---

**Thank you for contributing! Every PR, no matter how small, makes a difference.**