import { z } from "zod";

export const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const TopicSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional()
});

export const LearnSchema = z.object({
  topicId: z.string().min(3),
  url: z.string().url(),
  tags: z.array(z.string()).optional()
});

export const ExtractSkillsSchema = z.object({ topicId: z.string().min(3) });

export const SkillSchema = z.object({
  topicId: z.string().min(3),
  skillName: z.string().min(2),
  description: z.string().min(5),
  example: z.string().optional()
});

export const AskSchema = z.object({ question: z.string().min(3), limit: z.number().optional() });

export const ProjectSchema = z.object({
  name: z.string().min(2),
  description: z.string().min(5),
  stack: z.string().optional(),
  repoUrl: z.string().optional()
});

export const UpdateProjectSchema = z.object({
  skillIds: z.array(z.string()).optional(),
  name: z.string().min(2).optional(),
  description: z.string().min(5).optional(),
  stack: z.string().optional(),
  repoUrl: z.string().optional()
});

export const ConnectGithubSchema = z.object({ repoUrl: z.string().min(3) });

export const GithubTokenSchema = z.object({ token: z.string().min(1) });

export const DesignSchema = z.object({
  projectId: z.string().min(3),
  section: z.string().optional()
});

export const GeneratePlanSchema = z.object({
  projectId: z.string().min(3),
  instructions: z.string().optional()
});
