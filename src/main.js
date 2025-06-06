import * as core from '@actions/core';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger, handleError, withRetry, formatDate, IssueManager, ConcurrencyPool } from './utils.js';
import * as github from '@actions/github';

const RETRY_TIMES = core.getInput('retry_times') || 3;
const POSTS_COUNT = core.getInput('posts_count') || 2;
const DATE_FORMAT = core.getInput('date_format') || 'YYYY-MM-DD HH:mm:ss';
const CONCURRENCY_LIMIT = 10;

async function parseFeed(feedUrl) {
  try {
    const response = await axios.get(feedUrl, { timeout: 5000 });
    const $ = cheerio.load(response.data, { xmlMode: true });
    const posts = [];

    let isRss = false;
    let items = $('feed > entry');
    if (items.length === 0) {
      items = $('rss > channel > item');
      if (items.length > 0) {
        isRss = true;
      }
    }
    logger('info', `Feed URL: ${items.length} isRss: ${isRss}`);

    items.slice(0, POSTS_COUNT).each((i, el) => {
      const $item = $(el);
      const title = $item.find('title').first().text();

      let link;
      if (isRss) {
        link = $item.find('link').first().text();
      } else { // Atom
        link = $item.find('link[rel="alternate"]').attr('href');
        if (!link) {
          link = $item.find('link').attr('href');
        }
      }

      let publishedDateStr;
      if (isRss) {
        publishedDateStr = $item.find('pubDate').first().text();
      } else { // Atom
        publishedDateStr = $item.find('published').first().text();
      }

      const formattedPublished = publishedDateStr ? formatDate(publishedDateStr, DATE_FORMAT) : '';
      logger('info', `Extracted - Title: ${title}, Link: ${link}, Published: ${formattedPublished}`);

      if (title && link) {
        posts.push({ title, link, published: formattedPublished });
      }
    });

    return posts;
  } catch (error) {
    handleError(error, `Error parsing feed from ${feedUrl}`);
    return [];
  }
}

async function processIssue(issue) {
  try {
    logger('info', `Processing issue #${issue.number}`);
    if (!issue.body) {
      logger('warn', `Issue #${issue.number} has no body content, skipping...`);
      return null;
    }

    const match = issue.body.match(/```json\s*\{[\s\S]*?\}\s*```/m);
    const jsonMatch = match ? match[0].match(/\{[\s\S]*\}/m) : null;

    if (!jsonMatch) {
      logger('warn', `No JSON content found in issue #${issue.number}`);
      return null;
    }

    logger('info', `Found JSON content in issue #${issue.number}, jsonMatch[0]: ${jsonMatch[0]}`);
    const jsonData = JSON.parse(jsonMatch[0]);
    logger('info', `Got JSON content in issue #${issue.number}`, jsonData);
    
    // 获取 feed 数据
    const feedUrl = jsonData.feed;
    if (feedUrl) {
      logger('info', `Getting feed data from ${feedUrl}`);
      const posts = await withRetry(() => parseFeed(feedUrl), RETRY_TIMES);
      jsonData.posts = posts;
    }

    logger('info', `Converted JSON content in issue #${issue.number}`, jsonData);
    const newBody = issue.body.replace(jsonMatch[0], JSON.stringify(jsonData, null, 2));
    return { data: jsonData, newBody: newBody };
  } catch (error) {
    handleError(error, `Error processing issue #${issue.number}`);
    return null;
  }
}

async function run() {
  const token =  process.env.GITHUB_TOKEN;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const issueManager = new IssueManager(token);

  try {
    logger('info', `>> 开始`);
    const allIssues = await issueManager.getIssues();

    const pool = new ConcurrencyPool(CONCURRENCY_LIMIT);

    for (const issue of allIssues) {
      await pool.add(async () => {
        const result = await processIssue(issue);
        if (result) {
          // 更新 issue body
          await issueManager.octokit.issues.update({
            owner,
            repo,
            issue_number: issue.number,
            body: result.newBody
          });
          logger('info', `Updated issue #${issue.number}`);
        }
      });
    }

    logger('info', `>> 结束`);
  } catch (error) {
    // handleError(error, 'Error processing issues');
    logger('error', `Error processing issues`);
    process.exit(1);
  }
}

run();