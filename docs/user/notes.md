# Notes

Notes are markdown scratch files that live next to your threads, not in your repository. Each
thread has its own notes, and each project has notes that all its threads share. They are kept on
the machine that runs the project, so a remote project's notes stay on that machine.

## Write notes

Open **Notes** from the right panel launcher, or press `mod+alt+m` in a thread. Switch between
**This thread** and **Project**, and choose **New note**. `mod+alt+shift+n` creates a note in the
current thread and opens it. Notes save as you type. Search note titles from the command palette.

Each note's menu renames it, moves it between the thread and its project, or deletes it. Deleted
notes go to `notes/.trash` in the T3 data directory. Settling or deleting a thread keeps its notes.

If the same note changes in another window or is edited by an agent while you type, nothing is
overwritten: choose **Keep mine**, **Take theirs**, or **Save mine as copy**.

## Notes and agents

Agents in a thread can list, read, create, and update that thread's notes and its project's notes.
Ask in plain words, for example "summarise this thread into a note".

A note's menu can also start a prompt for you: **Send to agent**, **Create a Jira issue from this
note**, **Turn this note into a Confluence page**, or **Summarise this thread into this note**. The
prompt lands in the composer for you to review and send. Jira and Confluence need the Atlassian MCP
server set up in your provider; the agent then writes the issue key or page link back into the note.
