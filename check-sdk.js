// First, create a simple script to check what's available in the package
// Save this as check-sdk.js

import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Try to find the package location directly
try {
  // Look in node_modules
  const nodeModulesPath = join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk');
  
  if (fs.existsSync(nodeModulesPath)) {
    console.log('Package found at:', nodeModulesPath);
    
    // Read package.json
    try {
      const packageJsonPath = join(nodeModulesPath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        console.log('\nPackage.json contents:');
        console.log(JSON.stringify(packageJson, null, 2));
        
        // Check main entry points
        console.log('\nMain entry points:');
        console.log('main:', packageJson.main);
        console.log('module:', packageJson.module);
        console.log('types:', packageJson.types);
      } else {
        console.log('package.json not found');
      }
    } catch (error) {
      console.error('Error reading package.json:', error.message);
    }
    
    // List directories at the root level
    const rootDirs = fs.readdirSync(nodeModulesPath, { withFileTypes: true });
    console.log('\nRoot directories:');
    rootDirs.forEach(dir => {
      console.log(`- ${dir.name}${dir.isDirectory() ? '/' : ''}`);
    });
    
    // Check if 'dist' directory exists
    const distPath = join(nodeModulesPath, 'dist');
    if (fs.existsSync(distPath)) {
      console.log('\nContents of dist/ directory:');
      const listDistRecursively = (dir, depth = 0) => {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        
        files.forEach(file => {
          const indent = ' '.repeat(depth * 2);
          console.log(`${indent}- ${file.name}${file.isDirectory() ? '/' : ''}`);
          
          if (file.isDirectory()) {
            listDistRecursively(join(dir, file.name), depth + 1);
          }
        });
      };
      
      listDistRecursively(distPath);
      
      // Look for specific files that might contain McpServer
      const filesToCheck = [
        join(distPath, 'index.js'),
        join(distPath, 'server', 'index.js'),
        join(distPath, 'server.js')
      ];
      
      console.log('\nChecking for potential server modules:');
      filesToCheck.forEach(file => {
        if (fs.existsSync(file)) {
          console.log(`Found: ${file}`);
          // Read the file to look for exports
          const content = fs.readFileSync(file, 'utf8');
          const exportLines = content.split('\n')
            .filter(line => line.includes('export') || line.includes('McpServer'))
            .map(line => line.trim());
          
          console.log(`  Exports found in ${file.split('/').pop()}:`);
          exportLines.forEach(line => console.log(`    ${line}`));
        }
      });
    } else {
      console.log('\ndist/ directory not found');
    }
  } else {
    console.error('Package not found in node_modules');
  }
} catch (error) {
  console.error('Error examining package:', error);
}