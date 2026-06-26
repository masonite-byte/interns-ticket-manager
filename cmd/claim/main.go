package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/joho/godotenv"
	"github.com/slack-go/slack"
)

func main() {
	_ = godotenv.Load()

	issueNumber := os.Getenv("ISSUE_NUMBER")
	githubUsername := os.Getenv("GITHUB_USERNAME")
	githubToken := os.Getenv("GITHUB_TOKEN")
	githubRepo := os.Getenv("GITHUB_REPO")
	slackToken := os.Getenv("SLACK_BOT_TOKEN")
	slackUserID := os.Getenv("SLACK_USER_ID")

	if issueNumber == "" || githubUsername == "" || githubToken == "" || githubRepo == "" {
		slog.Error("missing required env vars")
		os.Exit(1)
	}

	if err := assignIssue(githubRepo, issueNumber, githubUsername, githubToken); err != nil {
		slog.Error("failed to assign issue", "error", err)
		os.Exit(1)
	}

	slog.Info("assigned issue", "number", issueNumber, "user", githubUsername)

	if slackToken != "" && slackUserID != "" {
		client := slack.New(slackToken)
		msg := fmt.Sprintf("✅ Issue #%s has been assigned to you on GitHub.", issueNumber)
		if _, _, err := client.PostMessage(slackUserID, slack.MsgOptionText(msg, false)); err != nil {
			slog.Error("failed to DM user", "error", err)
		}
	}
}

func assignIssue(repo, number, username, token string) error {
	url := fmt.Sprintf("https://api.github.com/repos/%s/issues/%s/assignees", repo, number)
	body, _ := json.Marshal(map[string][]string{"assignees": {username}})

	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "interns-ticket-manager")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}
	return nil
}
