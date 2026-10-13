export interface Task {
  id: number;
  title: string;
  notes: string;
  dueDate: string | null;
  dueTime: string | null;
  priority: 0 | 1 | 2;
  done: boolean;
  createdAt: string;
}

export interface TaskInput {
  title: string;
  notes?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  priority?: number;
}
