const { createCanvas } = require('canvas');
const Chart = require('chart.js/auto');
const fs = require('fs');
const path = require('path');

class ChartGenerator {
    constructor() {
        this.tempDir = path.join(__dirname, '../../temp_charts');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async generateTradeChart(tradeData, candles) {
        return new Promise(async (resolve, reject) => {
            try {
                const {
                    asset, direction, investment, profit, isWin,
                    entryPrice, exitPrice, openTime, closeTime, tradeId,
                    currency
                } = tradeData;

                // Create canvas - 1200x600 for high quality
                const width = 1200;
                const height = 600;
                const canvas = createCanvas(width, height);
                const ctx = canvas.getContext('2d');

                // Set dark background (#101622)
                ctx.fillStyle = '#101622';
                ctx.fillRect(0, 0, width, height);

                // Format candles for Chart.js
                const chartData = candles.map(c => ({
                    x: new Date(c.from * 1000),
                    o: c.open,
                    h: c.max,
                    l: c.min,
                    c: c.close
                }));

                // Draw title
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 24px Inter, sans-serif';
                ctx.fillText(`${asset} - ${direction} Trade`, 50, 50);

                // Draw profit/loss box
                const profitColor = isWin ? '#10b981' : '#ef4444';
                ctx.fillStyle = profitColor;
                ctx.font = 'bold 20px Inter, sans-serif';
                const profitText = `${isWin ? 'WIN' : 'LOSS'}: ${currency}${Math.abs(profit).toFixed(2)}`;
                const textWidth = ctx.measureText(profitText).width;
                ctx.fillRect(width - textWidth - 70, 30, textWidth + 40, 40);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(profitText, width - textWidth - 50, 58);

                // Draw trade info
                ctx.fillStyle = '#94a3b8';
                ctx.font = '16px Inter, sans-serif';
                ctx.fillText(`Investment: ${currency}${investment}`, 50, 90);

                const durationMin = Math.round((closeTime - openTime) / 60000);
                ctx.fillText(`Duration: ${durationMin} min`, 50, 115);

                const startTime = new Date(openTime).toLocaleTimeString();
                const endTime = new Date(closeTime).toLocaleTimeString();
                ctx.fillText(`${startTime} - ${endTime}`, 50, 140);

                // Draw entry/exit prices
                ctx.fillStyle = '#f97316';
                ctx.font = '14px Inter, monospace';
                ctx.fillText(`ENTRY: ${entryPrice}`, 50, 180);

                ctx.fillStyle = isWin ? '#10b981' : '#ef4444';
                ctx.fillText(`EXIT: ${exitPrice}`, 50, 205);

                // Create chart
                const chartCanvas = createCanvas(width - 100, 350);
                const chartCtx = chartCanvas.getContext('2d');

                new Chart(chartCtx, {
                    type: 'candlestick',
                    data: {
                        datasets: [{
                            label: asset,
                            data: chartData,
                            borderColor: 'rgba(0,0,0,0)',
                            backgroundColor: d => d.raw.c >= d.raw.o ? '#10b98180' : '#ef444480',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: false,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: { enabled: false }
                        },
                        scales: {
                            x: {
                                grid: { color: '#1e293b' },
                                ticks: { color: '#94a3b8', maxTicksLimit: 8 }
                            },
                            y: {
                                grid: { color: '#1e293b' },
                                ticks: { color: '#94a3b8' },
                                beginAtZero: false
                            }
                        },
                        layout: {
                            padding: { top: 20, bottom: 20 }
                        }
                    }
                });

                // Draw entry/exit lines
                const chartY = 250;
                const chartHeight = 350;

                // Calculate Y position for entry/exit prices
                const prices = chartData.map(d => [d.h, d.l]).flat();
                const minPrice = Math.min(...prices) * 0.9999;
                const maxPrice = Math.max(...prices) * 1.0001;

                const getY = (price) => {
                    return chartY + chartHeight - ((price - minPrice) / (maxPrice - minPrice)) * chartHeight;
                };

                // Draw entry line (orange dashed)
                ctx.beginPath();
                ctx.strokeStyle = '#f97316';
                ctx.setLineDash([5, 5]);
                ctx.lineWidth = 2;
                const entryY = getY(entryPrice);
                ctx.moveTo(50, entryY);
                ctx.lineTo(width - 50, entryY);
                ctx.stroke();

                // Draw exit line (green/red)
                ctx.beginPath();
                ctx.strokeStyle = isWin ? '#10b981' : '#ef4444';
                ctx.setLineDash([5, 5]);
                const exitY = getY(exitPrice);
                ctx.moveTo(50, exitY);
                ctx.lineTo(width - 50, exitY);
                ctx.stroke();
                ctx.setLineDash([]);

                // Draw labels
                ctx.fillStyle = '#f97316';
                ctx.font = 'bold 12px Inter, sans-serif';
                ctx.fillText(`ENTRY: ${entryPrice}`, 60, entryY - 5);

                ctx.fillStyle = isWin ? '#10b981' : '#ef4444';
                ctx.fillText(`EXIT: ${exitPrice}`, 60, exitY - 5);

                // Draw candlestick chart
                ctx.drawImage(chartCanvas, 50, chartY, width - 100, chartHeight);

                // Save chart
                const filename = `trade_${tradeId}_${Date.now()}.png`;
                const filepath = path.join(this.tempDir, filename);

                const buffer = canvas.toBuffer('image/png');
                fs.writeFileSync(filepath, buffer);

                resolve(filepath);

            } catch (error) {
                console.error('Error generating chart:', error);
                reject(error);
            }
        });
    }

    cleanup(filepath) {
        try {
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
        } catch (error) {
            console.error('Error cleaning up chart:', error);
        }
    }
}

module.exports = ChartGenerator;