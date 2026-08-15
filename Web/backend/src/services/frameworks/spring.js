const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

/**
 * Reads the manifest file from a compiled JAR to extract the Main-Class attribute.
 */
const getMainClassFromJar = async (jarPath) => {
  try {
    if (!fs.existsSync(jarPath)) return null;
    const directory = await unzipper.Open.file(jarPath);
    const manifestFile = directory.files.find(d => d.path === 'META-INF/MANIFEST.MF');
    if (manifestFile) {
      const content = await manifestFile.buffer();
      const lines = content.toString('utf8').split('\n');
      const mainClassLine = lines.find(l => l.trim().startsWith('Main-Class:'));
      if (mainClassLine) {
        return mainClassLine.split(':')[1].trim();
      }
    }
  } catch (err) {
    console.error('[Spring Plugin] Failed to read jar manifest:', err);
  }
  return null;
};

module.exports = {
  id: 'spring',
  detect: (targetDir) => {
    return (
      fs.existsSync(path.join(targetDir, 'pom.xml')) ||
      fs.existsSync(path.join(targetDir, 'build.gradle')) ||
      fs.existsSync(path.join(targetDir, 'build.gradle.kts'))
    );
  },
  buildImage: 'maven:3.9-eclipse-temurin-21',
  runCommand: 'mvn clean package dependency:copy-dependencies -DskipTests', // Copies dependencies during Maven build
  getPreviewCommand: async (workDir) => {
    // 1. Look for jar files inside target/
    const targetDir = path.join(workDir, 'target');
    if (fs.existsSync(targetDir)) {
      const jars = fs.readdirSync(targetDir).filter(f => f.endsWith('.jar'));
      if (jars.length > 0) {
        const jarPath = path.join(targetDir, jars[0]);
        const mainClass = await getMainClassFromJar(jarPath);
        const depDir = path.join(targetDir, 'dependency');
        
        // If dependencies folder and a main class are both present, run using classpath
        if (mainClass && fs.existsSync(depDir)) {
          return { cmd: 'java', args: ['-cp', 'target/*:target/dependency/*', mainClass], env: {} };
        }
        
        // Fallback to standard jar execution
        return { cmd: 'java', args: ['-jar', `target/${jars[0]}`], env: {} };
      }
    }
    // 2. Look for jar files inside build/libs/ (Gradle)
    const buildLibsDir = path.join(workDir, 'build', 'libs');
    if (fs.existsSync(buildLibsDir)) {
      const jars = fs.readdirSync(buildLibsDir).filter(f => f.endsWith('.jar'));
      if (jars.length > 0) {
        return { cmd: 'java', args: ['-jar', `build/libs/${jars[0]}`], env: {} };
      }
    }
    return { cmd: 'echo', args: ['Spring/Java Boot JAR not found.'], env: {} };
  },
  // Custom initialization logic hook to return detailed config overrides dynamically
  getConfig: (targetDir) => {
    const isGradle = fs.existsSync(path.join(targetDir, 'build.gradle')) || fs.existsSync(path.join(targetDir, 'build.gradle.kts'));
    if (isGradle) {
      return {
        buildImage: 'gradle:8.5-jdk21-jammy',
        runCommand: './gradlew build -x test || gradle build -x test'
      };
    }
    return {
      buildImage: 'maven:3.9-eclipse-temurin-21',
      runCommand: 'mvn clean package dependency:copy-dependencies -DskipTests'
    };
  },
  detectGui: (targetDir) => {
    const detectJavaGui = (dir) => {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (f === 'node_modules' || f === '.git' || f === 'target' || f === 'build') continue;
            if (detectJavaGui(full)) return true;
          } else if (f.endsWith('.java')) {
            const content = fs.readFileSync(full, 'utf8');
            if (content.includes('javax.swing') || content.includes('java.awt') || content.includes('javafx.')) {
              return true;
            }
          }
        }
      } catch (_) {}
      return false;
    };
    return detectJavaGui(targetDir);
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
