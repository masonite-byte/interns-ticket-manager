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
	slackChannelID := os.Getenv("SLACK_CHANNEL_ID")

	if issueNumber == "" || githubUsername == "" || githubToken == "" || githubRepo == "" {
		slog.Error("missing required env vars")
		os.Exit(1)
	}

	if err := unassignIssue(githubRepo, issueNumber, githubUsername, githubToken); err != nil {
		slog.Error("failed to unassign issue", "error", err)
		os.Exit(1)
	}

	slog.Info("unassigned issue", "number", issueNumber, "user", githubUsername)

	if slackToken != "" {
		client := slack.New(slackToken)

		if slackUserID != "" {
			dm := fmt.Sprintf("↩️ You abandoned issue #%s — it's back in the pool.", issueNumber)
			if _, _, err := client.PostMessage(slackUserID, slack.MsgOptionText(dm, false)); err != nil {
				slog.Error("failed to DM user", "error", err)
			}
		}

		if slackChannelID != "" {
			announcement := fmt.Sprintf("<@%s> abandoned issue #%s — it's unclaimed again.", slackUserID, issueNumber)
			if _, _, err := client.PostMessage(slackChannelID, slack.MsgOptionText(announcement, false)); err != nil {
				slog.Error("failed to post to channel", "error", err)
			}
		}
	}
}

func unassignIssue(repo, number, username, token string) error {
	return unassignIssueWithBase("https://api.github.com", repo, number, username, token)
}

func unassignIssueWithBase(baseURL, repo, number, username, token string) error {
	url := fmt.Sprintf("%s/repos/%s/issues/%s/assignees", baseURL, repo, number)
	body, _ := json.Marshal(map[string][]string{"assignees": {username}})

	req, err := http.NewRequest("DELETE", url, bytes.NewReader(body))
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
