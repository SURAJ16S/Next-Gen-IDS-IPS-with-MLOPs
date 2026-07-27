# Team Workflow & Contribution Guide

Welcome to the team! To keep our codebase clean, secure, and bug-free, we have adopted a new standard workflow for contributing code.

## 🚀 The Golden Rule
**Never push your code directly to the `main` branch.** 

All new code must be pushed to a separate branch, and then a **Pull Request (PR)** must be opened. 

We have a `.github/CODEOWNERS` file set up so that whenever a Pull Request is opened, the project leads (**Suraj** and **Yash**) will automatically be notified to review the code. **Do not merge your own Pull Request**; wait for an approval and merge from the reviewers.

---

## 📖 Step-by-Step Example Workflow

Imagine Abhijit wants to add a new feature. Here is exactly what he should do:

### Step 1: Create a New Branch
Instead of writing code on `main`, Abhijit creates a new branch on his local computer. It's a good practice to name the branch after the feature you are building.

```bash
# Make sure you are up to date first!
git checkout main
git pull origin main

# Create and switch to a new branch
git checkout -b abhijit-new-dashboard
```

### Step 2: Write Code and Commit
Abhijit writes his code, tests it, and then commits his work exactly like normal:

```bash
git add .
git commit -m "feat: added a new dashboard view"
```

### Step 3: Push the Branch to GitHub
Instead of pushing to main, Abhijit pushes his specific branch up to GitHub:

```bash
git push origin abhijit-new-dashboard
```

### Step 4: Open a Pull Request
1. Abhijit goes to the repository page on GitHub.com.
2. A green button will appear saying *"Compare & pull request"*. He clicks it.
3. He writes a short description of what his code does.
4. He clicks **Create pull request**.

### Step 5: Automatic Review
* **The Magic:** As soon as the PR is created, GitHub automatically tags `@SURAJ16S` and `@borudeyash1` as required reviewers!
* Suraj or Yash will receive a notification, read through the code changes, and leave comments if anything needs fixing.
* Once they are happy with the code, they will click **Approve** and **Merge**, securely bringing Abhijit's code into the `main` branch.

---

## 🛠️ Recent Repository Updates
For context, the following maintenance tasks were recently completed to streamline this repository:

1. **Merged AegisProxy:** The `AegisProxy` branch was fully merged into `main` and can now be safely deleted.
2. **Standardized `.gitignore`:** The `.gitignore` was completely rewritten to globally ignore all `node_modules/` and `.env` files automatically, so they will never accidentally be committed again regardless of what directory they are in.
3. **Automated Reviewers:** Created the `.github/CODEOWNERS` file to automatically route all code reviews to Suraj and Yash. 
