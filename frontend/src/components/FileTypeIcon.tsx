import React from 'react';
import {
  Braces,
  Database,
  FileCode,
  FileCog,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Terminal,
} from 'lucide-react';
import { getFileVisual } from '../utils/fileUtils';

interface Props {
  name: string;
  type?: 'directory' | 'notebook' | 'file';
  isOpenFolder?: boolean;
  size?: number;
}

export const FileTypeIcon: React.FC<Props> = ({
  name,
  type,
  isOpenFolder = false,
  size = 15,
}) => {
  const visual = getFileVisual({ name, type });

  switch (visual.category) {
    case 'directory':
      return isOpenFolder ? (
        <FolderOpen size={size} className="shrink-0" style={{ color: visual.color }} />
      ) : (
        <Folder size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'notebook':
      return (
        <FileCode size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'python':
      return (
        <FileCode size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'data':
      return (
        <FileSpreadsheet size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'json':
      return (
        <Braces size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'shell':
      return (
        <Terminal size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'config':
      return (
        <FileCog size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'sql':
      return (
        <Database size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'web':
      return (
        <FileCode size={size} className="shrink-0" style={{ color: visual.color }} />
      );
    case 'markdown':
    case 'text':
    default:
      return (
        <FileText size={size} className="shrink-0" style={{ color: visual.color }} />
      );
  }
};
