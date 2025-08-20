import chalk from 'chalk';
import { LoadTestResults, WorkerStats } from './types';
import { Logger } from './logger';

export class ResultsReporter {
  private static logger = Logger.getInstance();

  static printResults(results: LoadTestResults): void {
    this.logger.section('SOLANA RPC LOAD TEST RESULTS');

    // Summary
    this.printSummary(results);
    
    // Latency statistics
    this.printLatencyStats(results);
    
    // Method breakdown
    this.printMethodBreakdown(results);
    
    // Worker statistics
    this.printWorkerStats(results.workerStats);
    
    // Error analysis
    this.printErrorAnalysis(results);
    
    // Performance metrics
    this.printPerformanceMetrics(results);
  }

  private static printSummary(results: LoadTestResults): void {
    this.logger.section('SUMMARY');
    this.logger.info(`Total Requests:     ${results.totalRequests.toLocaleString()}`);
    this.logger.info(`Successful:         ${results.successfulRequests.toLocaleString()}`);
    this.logger.info(`Failed:             ${results.failedRequests.toLocaleString()}`);
    this.logger.info(`Success Rate:       ${((results.successfulRequests / results.totalRequests) * 100).toFixed(2)}%`);
    this.logger.info(`Max RPS Achieved:   ${results.maxRps.toFixed(2)}`);
    this.logger.info(`Actual RPS:         ${results.actualRps.toFixed(2)}`);
    this.logger.info(`Test Duration:      ${results.testDuration.toFixed(2)}s`);
  }

  private static printLatencyStats(results: LoadTestResults): void {
    this.logger.section('LATENCY STATISTICS (ms)');
    this.logger.info(`Average:            ${results.avgLatency.toFixed(2)}`);
    this.logger.info(`Median (P50):       ${results.p50Latency.toFixed(2)}`);
    this.logger.info(`95th Percentile:    ${results.p95Latency.toFixed(2)}`);
    this.logger.info(`99th Percentile:    ${results.p99Latency.toFixed(2)}`);
    this.logger.info(`Minimum:            ${results.minLatency.toFixed(2)}`);
    this.logger.info(`Maximum:            ${results.maxLatency.toFixed(2)}`);
  }

  private static printMethodBreakdown(results: LoadTestResults): void {
    this.logger.section('METHOD BREAKDOWN');
    
    // Header
    console.log(`${chalk.cyan('Method'.padEnd(25))} | ${chalk.green('Success'.padStart(8))} | ${chalk.red('Failed'.padStart(8))} | ${chalk.yellow('Rate%'.padStart(8))} | ${chalk.cyan('Avg(ms)'.padStart(10))} | ${chalk.blue('P95(ms)'.padStart(10))}`);
    console.log('-'.repeat(85));
    
    for (const [method, methodResults] of results.methodResults) {
      const total = methodResults.length;
      const successful = methodResults.filter(r => r.success);
      const failed = total - successful.length;
      const avgLatency = successful.length > 0 
        ? successful.reduce((sum, r) => sum + r.latency, 0) / successful.length 
        : 0;
      
      const p95Latencies = successful.map(r => r.latency).sort((a, b) => a - b);
      const p95Index = Math.floor(p95Latencies.length * 0.95);
      const p95Latency = p95Latencies.length > 0 ? p95Latencies[p95Index] : 0;
      
      const successRate = total > 0 ? (successful.length / total * 100).toFixed(1) : '0.0';
      
      console.log(
        `${chalk.cyan(method.padEnd(25))} | ` +
        `${chalk.green(successful.length.toString().padStart(8))} | ` +
        `${chalk.red(failed.toString().padStart(8))} | ` +
        `${chalk.yellow(successRate.padStart(6))}% | ` +
        `${chalk.cyan(avgLatency.toFixed(2).padStart(10))} | ` +
        `${chalk.blue(p95Latency.toFixed(2).padStart(10))}`
      );
    }
  }

  private static printWorkerStats(workerStats: WorkerStats[]): void {
    if (workerStats.length === 0) return;

    this.logger.section('WORKER STATISTICS');
    
    // Header
    console.log(`${chalk.cyan('Worker'.padEnd(8))} | ${chalk.green('Requests'.padStart(10))} | ${chalk.red('Errors'.padStart(8))} | ${chalk.yellow('Avg Latency'.padStart(12))} | ${chalk.blue('Runtime'.padStart(10))}`);
    console.log('-'.repeat(65));
    
    let totalRequests = 0;
    let totalErrors = 0;
    let totalLatency = 0;
    
    for (const stat of workerStats) {
      const runtime = (stat.endTime - stat.startTime) / 1000;
      totalRequests += stat.requestsProcessed;
      totalErrors += stat.errors;
      totalLatency += stat.avgLatency * stat.requestsProcessed;
      
      console.log(
        `${chalk.cyan(stat.workerId.toString().padEnd(8))} | ` +
        `${chalk.green(stat.requestsProcessed.toString().padStart(10))} | ` +
        `${chalk.red(stat.errors.toString().padStart(8))} | ` +
        `${chalk.yellow(stat.avgLatency.toFixed(2).padStart(12))} | ` +
        `${chalk.blue(runtime.toFixed(1).padStart(10))}s`
      );
    }
    
    // Summary
    console.log('-'.repeat(65));
    const overallAvgLatency = totalRequests > 0 ? totalLatency / totalRequests : 0;
    console.log(
      `${chalk.cyan('TOTAL'.padEnd(8))} | ` +
      `${chalk.green(totalRequests.toString().padStart(10))} | ` +
      `${chalk.red(totalErrors.toString().padStart(8))} | ` +
      `${chalk.yellow(overallAvgLatency.toFixed(2).padStart(12))} | ` +
      `${chalk.blue(''.padStart(10))}`
    );
  }

  private static printErrorAnalysis(results: LoadTestResults): void {
    if (results.errors.length === 0) {
      this.logger.section('NO ERRORS DETECTED');
      return;
    }

    this.logger.section('ERROR ANALYSIS');
    
    // Sort errors by count (descending)
    const sortedErrors = results.errors.sort((a, b) => b.count - a.count);
    
    // Header
    console.log(`${chalk.red('Count'.padStart(6))} | ${chalk.cyan('Method'.padEnd(25))} | ${chalk.yellow('Error Message')}`);
    console.log('-'.repeat(80));
    
    for (const error of sortedErrors) {
      console.log(
        `${chalk.red(error.count.toString().padStart(6))} | ` +
        `${chalk.cyan(error.method.padEnd(25))} | ` +
        `${chalk.yellow(error.error)}`
      );
    }
  }

  private static printPerformanceMetrics(results: LoadTestResults): void {
    this.logger.section('PERFORMANCE METRICS');
    
    const throughput = results.successfulRequests / (results.totalLatency / 1000);
    const errorRate = (results.failedRequests / results.totalRequests) * 100;
    
    this.logger.info(`Throughput:         ${throughput.toFixed(2)} req/s`);
    this.logger.info(`Error Rate:         ${errorRate.toFixed(2)}%`);
    this.logger.info(`Total Latency:      ${(results.totalLatency / 1000).toFixed(2)}s`);
    
    // Performance grade
    let grade = 'F';
    let gradeColor = chalk.red;
    
    if (errorRate < 1 && results.avgLatency < 100) {
      grade = 'A+';
      gradeColor = chalk.green;
    } else if (errorRate < 5 && results.avgLatency < 200) {
      grade = 'A';
      gradeColor = chalk.green;
    } else if (errorRate < 10 && results.avgLatency < 500) {
      grade = 'B';
      gradeColor = chalk.yellow;
    } else if (errorRate < 20 && results.avgLatency < 1000) {
      grade = 'C';
      gradeColor = chalk.yellow;
    } else if (errorRate < 30) {
      grade = 'D';
      gradeColor = chalk.red;
    }
    
    this.logger.info(`Performance Grade:  ${gradeColor(grade)}`);
  }

  static printProgress(current: number, total: number, elapsed: number): void {
    const percentage = ((current / total) * 100).toFixed(1);
    const remaining = total - current;
    const eta = remaining > 0 ? (elapsed / current) * remaining : 0;
    
    process.stdout.write(`\r${chalk.cyan('Progress:')} ${chalk.green(percentage + '%')} | ${chalk.yellow('ETA:')} ${chalk.cyan(eta.toFixed(1) + 's')} | ${chalk.blue('Elapsed:')} ${chalk.cyan(elapsed.toFixed(1) + 's')}`);
  }

  static printRealTimeStats(requests: number, errors: number, elapsed: number): void {
    const rps = elapsed > 0 ? requests / elapsed : 0;
    const errorRate = requests > 0 ? (errors / requests) * 100 : 0;
    
    process.stdout.write(
      `\r${chalk.cyan('Requests:')} ${chalk.green(requests)} | ` +
      `${chalk.red('Errors:')} ${chalk.red(errors)} | ` +
      `${chalk.yellow('RPS:')} ${chalk.yellow(rps.toFixed(2))} | ` +
      `${chalk.red('Error Rate:')} ${chalk.red(errorRate.toFixed(2) + '%')} | ` +
      `${chalk.blue('Time:')} ${chalk.cyan(elapsed.toFixed(1) + 's')}`
    );
  }

  // Export results to JSON
  static exportToJson(results: LoadTestResults, filename?: string): string {
    const exportData = {
      ...results,
      methodResults: Object.fromEntries(results.methodResults),
      timestamp: new Date().toISOString(),
      version: '2.0.0'
    };

    const jsonString = JSON.stringify(exportData, null, 2);
    
    if (filename) {
      const fs = require('fs');
      fs.writeFileSync(filename, jsonString);
      this.logger.info(`Results exported to ${filename}`);
    }
    
    return jsonString;
  }

  // Export results to CSV
  static exportToCsv(results: LoadTestResults, filename?: string): string {
    let csv = 'Method,Success,Failed,SuccessRate,AvgLatency,P95Latency\n';
    
    for (const [method, methodResults] of results.methodResults) {
      const total = methodResults.length;
      const successful = methodResults.filter(r => r.success).length;
      const failed = total - successful;
      const successRate = total > 0 ? (successful / total * 100) : 0;
      
      const successfulResults = methodResults.filter(r => r.success);
      const avgLatency = successfulResults.length > 0 
        ? successfulResults.reduce((sum, r) => sum + r.latency, 0) / successfulResults.length 
        : 0;
      
      const p95Latencies = successfulResults.map(r => r.latency).sort((a, b) => a - b);
      const p95Index = Math.floor(p95Latencies.length * 0.95);
      const p95Latency = p95Latencies.length > 0 ? p95Latencies[p95Index] : 0;
      
      csv += `${method},${successful},${failed},${successRate.toFixed(2)},${avgLatency.toFixed(2)},${p95Latency.toFixed(2)}\n`;
    }
    
    if (filename) {
      const fs = require('fs');
      fs.writeFileSync(filename, csv);
      this.logger.info(`Results exported to ${filename}`);
    }
    
    return csv;
  }
}
